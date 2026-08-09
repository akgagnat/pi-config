import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JobStatus } from "./jobs.ts";
import type { TelemetryEvent } from "./telemetry.ts";

export type ParentCorrelation = {
	readonly sessionId?: string;
	readonly toolCallId?: string;
	readonly entryId?: string;
	readonly turnIndex?: number;
};

export type ModelResolutionSource = "task" | "request" | "profile" | "parent" | "default";

/** Only clone-safe model fields are retained; provider implementations are deliberately excluded. */
export type JobModelMetadata = {
	readonly requested?: string;
	readonly source: ModelResolutionSource;
	readonly provider?: string;
	readonly id?: string;
	readonly contextWindow?: number;
	readonly thinkingLevel?: ModelThinkingLevel;
};

export type JobDeliveryMode = "foreground" | "background" | "batch";
export type JobDeliveryMethod = "tool-result" | "deferred-follow-up" | "subagent-wait";

export type JobDeliveryMetadata = {
	readonly mode: JobDeliveryMode;
	readonly method: JobDeliveryMethod;
	readonly consumedByWait: boolean;
	readonly originalOutputBytes?: number;
	readonly deliveredOutputBytes?: number;
	readonly outputTruncated?: boolean;
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export type BoundedTextSnapshot = {
	readonly text: string;
	readonly totalBytes: number;
	readonly truncated: boolean;
};

export type JobSnapshot = {
	readonly id: string;
	readonly name: string;
	readonly agent: string;
	readonly task: string;
	readonly cwd: string;
	readonly status: JobStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly finishedAt?: number;
	readonly exitCode?: number;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly parent: ParentCorrelation;
	readonly model: JobModelMetadata;
	readonly delivery: JobDeliveryMetadata;
	readonly timeline: readonly DeepReadonly<TelemetryEvent>[];
	readonly droppedTimelineEvents: number;
	readonly droppedSteeringEvents: number;
	readonly stderr: BoundedTextSnapshot;
	readonly output: BoundedTextSnapshot;
};

export type CreateJobInput = Omit<
	JobSnapshot,
	"status" | "startedAt" | "updatedAt" | "finishedAt" | "timeline" | "droppedTimelineEvents" | "droppedSteeringEvents" | "stderr" | "output"
> & {
	status?: JobStatus;
	startedAt?: number;
};

export type JobUpdate = Partial<Pick<JobSnapshot,
	"status" | "finishedAt" | "exitCode" | "stopReason" | "errorMessage" | "model" | "delivery"
>>;

export type JobStoreChange =
	| { readonly type: "created" | "updated"; readonly job: JobSnapshot }
	| { readonly type: "evicted" | "removed"; readonly job: JobSnapshot };

export type JobStoreListener = (change: JobStoreChange) => void;

export type JobStoreOptions = {
	maxTimelineEvents?: number;
	maxSteeringEvents?: number;
	maxStderrBytes?: number;
	maxOutputBytes?: number;
	maxCompletedJobs?: number;
	now?: () => number;
};

type MutableBoundedText = {
	text: string;
	totalBytes: number;
	truncated: boolean;
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type MutableJob = Omit<Mutable<JobSnapshot>, "timeline" | "stderr" | "output"> & {
	timeline: TelemetryEvent[];
	stderr: MutableBoundedText;
	output: MutableBoundedText;
};

const TERMINAL_STATUSES = new Set<JobStatus>(["done", "failed", "aborted"]);
const DEFAULT_MAX_TIMELINE_EVENTS = 500;
const DEFAULT_MAX_STEERING_EVENTS = 50;
const DEFAULT_MAX_STDERR_BYTES = 40_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const DEFAULT_MAX_COMPLETED_JOBS = 20;

function isTerminal(status: JobStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

function assertLimit(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
}

function bytePrefix(value: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function byteSuffix(value: string, maxBytes: number): string {
	let bytes = 0;
	const kept: string[] = [];
	const characters = [...value];
	for (let index = characters.length - 1; index >= 0; index--) {
		const character = characters[index];
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		kept.push(character);
		bytes += characterBytes;
	}
	return kept.reverse().join("");
}

function boundTelemetryEvent(event: TelemetryEvent): TelemetryEvent {
	const clone = structuredClone(event);
	if (clone.type === "text-delta") return { ...clone, delta: byteSuffix(clone.delta, 20_000) };
	if (clone.type === "thinking-delta") return { ...clone, delta: byteSuffix(clone.delta, 10_000) };
	if (clone.type === "assistant-message") return {
		...clone,
		text: bytePrefix(clone.text, 20_000),
		...(clone.thinking ? { thinking: bytePrefix(clone.thinking, 10_000) } : {}),
	};
	if (clone.type === "tool-start" && Buffer.byteLength(JSON.stringify(clone.args), "utf8") > 8_000) {
		return { ...clone, args: "[tool arguments omitted: over 8KB]" };
	}
	if (clone.type === "tool-update" && Buffer.byteLength(JSON.stringify(clone.partialResult), "utf8") > 8_000) {
		return { ...clone, partialResult: "[partial tool result omitted: over 8KB]" };
	}
	if (clone.type === "activity") return { ...clone, message: bytePrefix(clone.message, 2_000) };
	if (clone.type === "steering") return {
		...clone,
		instruction: bytePrefix(clone.instruction, 20_000),
		...(clone.message ? { message: bytePrefix(clone.message, 2_000) } : {}),
	};
	return clone;
}

function cloneAndFreeze<T>(value: T): T {
	const clone = structuredClone(value);
	const freeze = (current: unknown): void => {
		if (!current || typeof current !== "object" || Object.isFrozen(current)) return;
		for (const child of Object.values(current)) freeze(child);
		Object.freeze(current);
	};
	freeze(clone);
	return clone;
}

/** In-memory, transport-neutral state for subagent telemetry. */
export class JobStore {
	private readonly jobs = new Map<string, MutableJob>();
	private readonly completedJobIds: string[] = [];
	private readonly listeners = new Set<JobStoreListener>();
	private readonly maxTimelineEvents: number;
	private readonly maxSteeringEvents: number;
	private readonly maxStderrBytes: number;
	private readonly maxOutputBytes: number;
	private maxCompletedJobs: number;
	private readonly now: () => number;

	constructor(options: JobStoreOptions = {}) {
		this.maxTimelineEvents = options.maxTimelineEvents ?? DEFAULT_MAX_TIMELINE_EVENTS;
		this.maxSteeringEvents = options.maxSteeringEvents ?? DEFAULT_MAX_STEERING_EVENTS;
		this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		this.maxCompletedJobs = options.maxCompletedJobs ?? DEFAULT_MAX_COMPLETED_JOBS;
		this.now = options.now ?? Date.now;
		assertLimit("maxTimelineEvents", this.maxTimelineEvents);
		assertLimit("maxSteeringEvents", this.maxSteeringEvents);
		assertLimit("maxStderrBytes", this.maxStderrBytes);
		assertLimit("maxOutputBytes", this.maxOutputBytes);
		assertLimit("maxCompletedJobs", this.maxCompletedJobs);
	}

	create(input: CreateJobInput): JobSnapshot {
		if (this.jobs.has(input.id)) throw new Error(`Duplicate subagent job: ${input.id}`);
		const startedAt = input.startedAt ?? this.now();
		const status = input.status ?? "initializing";
		const job: MutableJob = {
			...structuredClone(input),
			status,
			startedAt,
			updatedAt: startedAt,
			timeline: [],
			droppedTimelineEvents: 0,
			droppedSteeringEvents: 0,
			stderr: { text: "", totalBytes: 0, truncated: false },
			output: { text: "", totalBytes: 0, truncated: false },
		};
		if (isTerminal(status)) job.finishedAt = startedAt;
		this.jobs.set(job.id, job);
		this.emit({ type: "created", job: this.snapshot(job) });
		if (isTerminal(status)) {
			this.completedJobIds.push(job.id);
			this.evictCompletedJobs();
		}
		return this.snapshot(job);
	}

	get(id: string): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : undefined;
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].map((job) => this.snapshot(job));
	}

	update(id: string, patch: JobUpdate): JobSnapshot {
		const job = this.requireJob(id);
		if (patch.status !== undefined && patch.status !== job.status) {
			const allowed = job.status === "initializing"
				? patch.status === "working" || isTerminal(patch.status)
				: job.status === "working"
					? isTerminal(patch.status)
					: false;
			if (!allowed) throw new Error(`Subagent job cannot transition from ${job.status} to ${patch.status}.`);
		}
		if (patch.finishedAt !== undefined && !isTerminal(patch.status ?? job.status)) {
			throw new Error("Only a terminal subagent job can have finishedAt.");
		}
		const wasTerminal = isTerminal(job.status);
		Object.assign(job, structuredClone(patch));
		job.updatedAt = this.now();
		if (!wasTerminal && isTerminal(job.status)) {
			job.finishedAt ??= job.updatedAt;
			this.completedJobIds.push(job.id);
		}
		const snapshot = this.snapshot(job);
		this.emit({ type: "updated", job: snapshot });
		if (!wasTerminal && isTerminal(job.status)) this.evictCompletedJobs();
		return snapshot;
	}

	appendTimeline(id: string, event: TelemetryEvent): JobSnapshot {
		const job = this.requireJob(id);
		const bounded = boundTelemetryEvent(event);
		const previous = job.timeline.at(-1);
		if (bounded.type === "text-delta" && previous?.type === "text-delta" && previous.contentIndex === bounded.contentIndex) {
			previous.delta = byteSuffix(previous.delta + bounded.delta, 20_000);
			previous.at = bounded.at;
		} else if (bounded.type === "thinking-delta" && previous?.type === "thinking-delta" && previous.contentIndex === bounded.contentIndex) {
			previous.delta = byteSuffix(previous.delta + bounded.delta, 10_000);
			previous.at = bounded.at;
		} else {
			job.timeline.push(bounded);
		}
		if (bounded.type === "steering") {
			let steeringCount = job.timeline.reduce((count, item) => count + Number(item.type === "steering"), 0);
			for (let index = 0; steeringCount > this.maxSteeringEvents && index < job.timeline.length;) {
				if (job.timeline[index].type !== "steering") { index++; continue; }
				job.timeline.splice(index, 1);
				job.droppedSteeringEvents++;
				steeringCount--;
			}
		}
		if (job.timeline.length > this.maxTimelineEvents) {
			const dropped = job.timeline.length - this.maxTimelineEvents;
			const removed = job.timeline.splice(0, dropped);
			job.droppedTimelineEvents += dropped;
			job.droppedSteeringEvents += removed.reduce((count, item) => count + Number(item.type === "steering"), 0);
		}
		return this.touch(job);
	}

	appendStderr(id: string, chunk: string, maxBytes = this.maxStderrBytes): JobSnapshot {
		assertLimit("maxBytes", maxBytes);
		const job = this.requireJob(id);
		job.stderr.totalBytes += Buffer.byteLength(chunk, "utf8");
		job.stderr.text = byteSuffix(job.stderr.text + chunk, maxBytes);
		job.stderr.truncated = job.stderr.totalBytes > Buffer.byteLength(job.stderr.text, "utf8");
		return this.touch(job);
	}

	/** Replace the final report, retaining its beginning while recording its full byte size. */
	setOutput(id: string, output: string, maxBytes = this.maxOutputBytes): JobSnapshot {
		assertLimit("maxBytes", maxBytes);
		const job = this.requireJob(id);
		job.output.totalBytes = Buffer.byteLength(output, "utf8");
		job.output.text = bytePrefix(output, maxBytes);
		const retainedBytes = Buffer.byteLength(job.output.text, "utf8");
		job.output.truncated = job.output.totalBytes > retainedBytes;
		job.delivery = {
			...job.delivery,
			originalOutputBytes: job.output.totalBytes,
			deliveredOutputBytes: retainedBytes,
			outputTruncated: job.output.truncated,
		};
		return this.touch(job);
	}

	setCompletedJobRetention(maxCompletedJobs: number): void {
		assertLimit("maxCompletedJobs", maxCompletedJobs);
		this.maxCompletedJobs = maxCompletedJobs;
		this.evictCompletedJobs();
	}

	subscribe(listener: JobStoreListener): () => void {
		this.listeners.add(listener);
		return () => this.unsubscribe(listener);
	}

	unsubscribe(listener: JobStoreListener): void {
		this.listeners.delete(listener);
	}

	remove(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		this.jobs.delete(id);
		const completedIndex = this.completedJobIds.indexOf(id);
		if (completedIndex >= 0) this.completedJobIds.splice(completedIndex, 1);
		this.emit({ type: "removed", job: this.snapshot(job) });
		return true;
	}

	private requireJob(id: string): MutableJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		return job;
	}

	private touch(job: MutableJob): JobSnapshot {
		job.updatedAt = this.now();
		const snapshot = this.snapshot(job);
		this.emit({ type: "updated", job: snapshot });
		return snapshot;
	}

	private snapshot(job: MutableJob): JobSnapshot {
		return cloneAndFreeze(job);
	}

	private emit(change: JobStoreChange): void {
		const immutableChange = cloneAndFreeze(change);
		for (const listener of [...this.listeners]) listener(immutableChange);
	}

	private evictCompletedJobs(): void {
		while (this.completedJobIds.length > this.maxCompletedJobs) {
			const id = this.completedJobIds.shift();
			if (!id) return;
			const job = this.jobs.get(id);
			if (!job || !isTerminal(job.status)) continue;
			this.jobs.delete(id);
			this.emit({ type: "evicted", job: this.snapshot(job) });
		}
	}
}
