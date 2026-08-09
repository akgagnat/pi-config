import { CONTACT_MAX_BYTES, CONTACT_TIMEOUT_MS, CONTACT_TITLE, decodeContactEnvelope, type ContactKind } from "./contact-protocol.ts";
import type { JobStore } from "./job-store.ts";

export type EscalationStatus = "pending" | "progress" | "replied" | "timed-out" | "cancelled" | "failed";
export type EscalationRecord = {
	readonly id: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly kind: ContactKind;
	readonly subject: string;
	readonly message: string;
	readonly status: EscalationStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly reply?: string;
	readonly error?: string;
};

type Channel = { sessionId: string; respond: (transportId: string, response: { value: string } | { cancelled: true }) => void };
type Pending = { transportId: string; timer: NodeJS.Timeout; channel: Channel };

const MAX_PENDING_PER_JOB = 8;
const MAX_HISTORY = 50;

type ExtensionUiRequest = { id: string; method: string; title?: string; placeholder?: string; message?: string };

/** Buffers reserved requests only after task prompting starts and before the parent channel attaches. */
export class EscalationIngress {
	private prompting = false;
	private readonly buffered: ExtensionUiRequest[] = [];

	constructor(private readonly registry: EscalationRegistry, private readonly jobId: string) {}

	beginPrompt(): void { this.prompting = true; }

	handle(request: ExtensionUiRequest): boolean {
		if (this.registry.receive(this.jobId, request)) return true;
		const encoded = request.method === "input" ? request.placeholder : request.method === "notify" ? request.message : undefined;
		const envelope = decodeContactEnvelope(encoded);
		if (!this.prompting || !envelope || (envelope.kind !== "progress" && request.title !== CONTACT_TITLE) || this.buffered.length >= MAX_PENDING_PER_JOB) return false;
		this.buffered.push(request);
		return true;
	}

	flush(cancel: (id: string) => void): void {
		for (const request of this.buffered.splice(0)) {
			if (!this.registry.receive(this.jobId, request) && request.method !== "notify") cancel(request.id);
		}
	}
}

export class EscalationRegistry {
	private readonly channels = new Map<string, Channel>();
	private readonly records = new Map<string, EscalationRecord>();
	private readonly pending = new Map<string, Pending>();

	constructor(
		private readonly store: JobStore,
		private readonly options: { timeoutMs?: number; maxPendingPerJob?: number; maxHistory?: number } = {},
	) {}

	register(jobId: string, channel: Channel): () => void {
		this.channels.set(jobId, channel);
		return () => {
			if (this.channels.get(jobId) === channel) this.closeJob(jobId, "child communication closed");
		};
	}

	receive(jobId: string, request: ExtensionUiRequest): boolean {
		const channel = this.channels.get(jobId);
		if (!channel) return false;
		const encoded = request.method === "input" ? request.placeholder : request.method === "notify" ? request.message : undefined;
		const envelope = decodeContactEnvelope(encoded);
		if (!envelope) return false;
		if (envelope.kind === "progress" && request.method !== "notify") return false;
		if (envelope.kind !== "progress" && (request.method !== "input" || request.title !== CONTACT_TITLE)) return false;
		if (this.records.has(envelope.requestId)) {
			if (request.method !== "notify") channel.respond(request.id, { cancelled: true });
			return true;
		}
		const now = Date.now();
		if (envelope.kind !== "progress" && [...this.records.values()].filter((record) => record.jobId === jobId && record.status === "pending").length >= (this.options.maxPendingPerJob ?? MAX_PENDING_PER_JOB)) {
			channel.respond(request.id, { cancelled: true });
			this.addRecord({ id: envelope.requestId, jobId, sessionId: channel.sessionId, kind: envelope.kind, subject: envelope.subject, message: envelope.message, status: "failed", createdAt: now, updatedAt: now, error: "too many pending supervisor requests" });
			return true;
		}
		const status = envelope.kind === "progress" ? "progress" : "pending";
		this.addRecord({ id: envelope.requestId, jobId, sessionId: channel.sessionId, kind: envelope.kind, subject: envelope.subject, message: envelope.message, status, createdAt: now, updatedAt: now });
		if (status === "pending") {
			const timer = setTimeout(() => this.finish(envelope.requestId, "timed-out", undefined, "supervisor reply timed out"), this.options.timeoutMs ?? CONTACT_TIMEOUT_MS);
			timer.unref();
			this.pending.set(envelope.requestId, { transportId: request.id, timer, channel });
		}
		return true;
	}

	list(sessionId: string, jobId?: string): EscalationRecord[] {
		return [...this.records.values()]
			.filter((record) => record.sessionId === sessionId && (!jobId || record.jobId === jobId))
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((record) => structuredClone(record));
	}

	reply(sessionId: string, id: string, reply: string): EscalationRecord {
		const text = reply.trim();
		if (!text) throw new Error("Supervisor reply must not be empty.");
		if (Buffer.byteLength(text, "utf8") > CONTACT_MAX_BYTES) throw new Error(`Supervisor reply exceeds ${CONTACT_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
		const record = this.records.get(id);
		if (!record || record.sessionId !== sessionId) throw new Error(`Unknown supervisor request: ${id}`);
		if (record.status !== "pending") throw new Error(`Supervisor request ${id} is already ${record.status}.`);
		const pending = this.pending.get(id);
		if (!pending) throw new Error(`Supervisor request ${id} is no longer pending.`);
		pending.channel.respond(pending.transportId, { value: text });
		return this.finish(id, "replied", text)!;
	}

	closeJob(jobId: string, reason: string): void {
		this.channels.delete(jobId);
		for (const record of this.records.values()) {
			if (record.jobId === jobId && record.status === "pending") this.finish(record.id, "cancelled", undefined, reason);
		}
	}

	clear(reason: string): void {
		for (const jobId of [...this.channels.keys()]) this.closeJob(jobId, reason);
		this.records.clear();
	}

	private finish(id: string, status: Exclude<EscalationStatus, "pending" | "progress">, reply?: string, error?: string): EscalationRecord | undefined {
		const current = this.records.get(id);
		if (!current || current.status !== "pending") return current;
		const pending = this.pending.get(id);
		if (pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			if (status !== "replied") pending.channel.respond(pending.transportId, { cancelled: true });
		}
		const record = { ...current, status, updatedAt: Date.now(), ...(reply ? { reply } : {}), ...(error ? { error } : {}) };
		this.records.set(id, record);
		this.recordTelemetry(record);
		return structuredClone(record);
	}

	private addRecord(record: EscalationRecord): void {
		this.records.set(record.id, record);
		this.recordTelemetry(record);
		while (this.records.size > (this.options.maxHistory ?? MAX_HISTORY)) {
			const oldest = this.records.keys().next().value as string | undefined;
			if (!oldest) break;
			const pending = this.pending.get(oldest);
			if (pending) { clearTimeout(pending.timer); pending.channel.respond(pending.transportId, { cancelled: true }); this.pending.delete(oldest); }
			this.records.delete(oldest);
		}
	}

	private recordTelemetry(record: EscalationRecord): void {
		if (!this.store.get(record.jobId)) return;
		this.store.appendTimeline(record.jobId, { type: "escalation", requestId: record.id, kind: record.kind, subject: record.subject, message: record.message, status: record.status, ...(record.reply ? { reply: record.reply } : {}), ...(record.error ? { error: record.error } : {}), at: record.updatedAt });
	}
}
