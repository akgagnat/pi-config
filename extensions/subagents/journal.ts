import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobSnapshot, JobStore, JobStoreChange } from "./job-store.ts";
import type { TelemetryEvent } from "./telemetry.ts";

export const JOURNAL_SCHEMA_VERSION = 1;

export type JournalLimits = {
	journalMaxEvents: number;
	journalRetention: number;
	journalMaxAgeMs: number;
};

export type JournalStatus = {
	schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
	artifactId: string;
	lifecycle: { state: JobSnapshot["status"]; writtenAt: number };
	projection: { eventsRetained: number; eventsTruncated: boolean };
	job: JobSnapshot;
};

export type JournalReader = {
	list(): Promise<JournalStatus[]>;
	read(artifactId: string): Promise<JournalStatus | undefined>;
};

const TERMINAL = new Set<JobSnapshot["status"]>(["done", "failed", "aborted"]);

export function defaultJournalDirectory(): string {
	return join(homedir(), ".pi", "agent", "subagent-journals");
}

function isJournalStatus(value: unknown): value is JournalStatus {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === JOURNAL_SCHEMA_VERSION
		&& typeof record.artifactId === "string"
		&& typeof record.lifecycle === "object"
		&& record.lifecycle !== null
		&& typeof record.projection === "object"
		&& record.projection !== null
		&& typeof record.job === "object"
		&& record.job !== null;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

/** Read-only, corruption-tolerant seam for a future finished-run inspector. */
export function createJournalReader(root = defaultJournalDirectory()): JournalReader {
	const read = async (artifactId: string): Promise<JournalStatus | undefined> => {
		if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return undefined;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(root, artifactId, "status.json"), "utf8"));
			return isJournalStatus(parsed) ? parsed : undefined;
		} catch { return undefined; }
	};
	return {
		async list(): Promise<JournalStatus[]> {
			let entries: string[];
			try { entries = await readdir(root); } catch { return []; }
			const journals = await Promise.all(entries.map(read));
			return journals.filter((journal): journal is JournalStatus => journal !== undefined)
				.sort((a, b) => b.job.startedAt - a.job.startedAt);
		},
		read,
	};
}

/**
 * Best-effort bounded projection of the live JobStore. This is intentionally
 * not a queue: it never restores or resumes children.
 */
export class RunJournal {
	readonly artifactId = randomUUID();
	private readonly directory: string;
	private pending = Promise.resolve();
	private unsubscribe?: () => void;

	constructor(
		private readonly store: JobStore,
		private readonly jobId: string,
		private readonly limits: JournalLimits,
		private readonly root = defaultJournalDirectory(),
		private readonly now: () => number = Date.now,
	) {
		this.directory = join(root, this.artifactId);
	}

	start(): void {
		this.unsubscribe = this.store.subscribe((change) => this.record(change));
		this.pending = this.pending.then(() => this.cleanup()).catch(() => {});
		const job = this.store.get(this.jobId);
		if (job) this.enqueue(job);
	}

	/** Wait for queued best-effort writes; useful to orderly hosts and tests. */
	flush(): Promise<void> {
		return this.pending;
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private record(change: JobStoreChange): void {
		if (change.job.id !== this.jobId) return;
		if (change.type === "evicted" || change.type === "removed") {
			this.stop();
			return;
		}
		this.enqueue(change.job);
	}

	private enqueue(job: JobSnapshot): void {
		this.pending = this.pending.then(() => this.write(job)).catch(() => {
			// Artifact I/O is observational only; never fail or delay a child run.
		});
	}

	private async write(job: JobSnapshot): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700).catch(() => {});
		await chmod(this.directory, 0o700);
		const status: JournalStatus = {
			schemaVersion: JOURNAL_SCHEMA_VERSION,
			artifactId: this.artifactId,
			lifecycle: { state: job.status, writtenAt: this.now() },
			projection: {
				eventsRetained: Math.min(job.timeline.length, this.limits.journalMaxEvents),
				eventsTruncated: job.timeline.length > this.limits.journalMaxEvents,
			},
			job,
		};
		const events = job.timeline.slice(-this.limits.journalMaxEvents).map((event) => JSON.stringify({
			schemaVersion: JOURNAL_SCHEMA_VERSION,
			kind: "telemetry",
			event: event as TelemetryEvent,
		})).join("\n") + (job.timeline.length ? "\n" : "");
		await Promise.all([
			writeAtomic(join(this.directory, "status.json"), JSON.stringify(status, null, 2) + "\n"),
			writeAtomic(join(this.directory, "events.jsonl"), events),
			writeAtomic(join(this.directory, "output.txt"), job.output.text),
			writeAtomic(join(this.directory, "stderr.txt"), job.stderr.text),
		]);
	}

	private async cleanup(): Promise<void> {
		let entries: string[];
		try {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			await chmod(this.root, 0o700);
			entries = await readdir(this.root);
		} catch { return; }
		const reader = createJournalReader(this.root);
		const journals = await Promise.all(entries.map(async (artifactId) => ({
			artifactId,
			journal: await reader.read(artifactId),
			modifiedAt: await stat(join(this.root, artifactId)).then((item) => item.mtimeMs).catch(() => 0),
		})));
		const completed = journals.filter((item) => item.journal && TERMINAL.has(item.journal.lifecycle.state))
			.sort((a, b) => (b.journal!.job.finishedAt ?? b.journal!.job.updatedAt) - (a.journal!.job.finishedAt ?? a.journal!.job.updatedAt));
		const expired = new Set(journals.filter((item) => this.now() - item.modifiedAt > this.limits.journalMaxAgeMs).map((item) => item.artifactId));
		for (const item of completed.slice(this.limits.journalRetention)) expired.add(item.artifactId);
		await Promise.all([...expired].filter((id) => id !== this.artifactId).map((id) => rm(join(this.root, id), { recursive: true, force: true }).catch(() => {})));
	}
}
