import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";

export type ContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

export type RpcSessionStats = {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: ContextUsage;
};

export type RpcProcessEvent = JsonAgentSessionEvent
	| { type: "extension_ui_request"; id: string; method: string; placeholder?: string; message?: string; title?: string }
	| { type: "transport_error"; message: string };

type RpcCommandBody = RpcCommand extends infer T ? T extends { id?: string } ? Omit<T, "id"> : never : never;

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1_000_000;
const DEFAULT_ABSOLUTE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
function normalizeKnownLargeRecord(value: any, maxTextBytes: number): any | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (value.type === "message_end" && value.message?.role === "assistant" && Array.isArray(value.message.content)) {
		let retained = 0;
		const contentBudget = Math.max(0, maxTextBytes - 100);
		const sourceBytes = value.message.content.reduce((total: number, part: any) => total + (typeof part?.text === "string" ? Buffer.byteLength(part.text, "utf8") : typeof part?.thinking === "string" ? Buffer.byteLength(part.thinking, "utf8") : 0), 0);
		const content = value.message.content.flatMap((part: any) => {
			if (part?.type !== "text" && part?.type !== "thinking") return [];
			const key = part.type === "text" ? "text" : "thinking";
			if (typeof part[key] !== "string" || retained >= contentBudget) return [];
			const text = bytePrefix(part[key], contentBudget - retained);
			retained += Buffer.byteLength(text, "utf8");
			return [{ type: part.type, [key]: text }];
		});
		if (sourceBytes > retained) content.push({ type: "text", text: "\n[RPC aggregate truncated to the normal frame projection bound.]" });
		const message = value.message;
		return {
			type: "message_end",
			message: {
				role: "assistant",
				content,
				api: typeof message.api === "string" ? bytePrefix(message.api, 500) : "unknown",
				provider: typeof message.provider === "string" ? bytePrefix(message.provider, 500) : "unknown",
				model: typeof message.model === "string" ? bytePrefix(message.model, 500) : "unknown",
				usage: message.usage && Buffer.byteLength(JSON.stringify(message.usage), "utf8") <= 8_000 ? message.usage : undefined,
				stopReason: typeof message.stopReason === "string" ? message.stopReason : "stop",
				errorMessage: typeof message.errorMessage === "string" ? bytePrefix(message.errorMessage, 2_000) : undefined,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
			},
		};
	}
	if (value.type === "turn_end" && value.message && typeof value.message === "object") return { type: "turn_end", message: { role: value.message.role ?? "assistant", content: [] }, toolResults: [] };
	if (value.type === "agent_end" && Array.isArray(value.messages)) return { type: "agent_end", messages: [], willRetry: Boolean(value.willRetry) };
	if (value.type === "tool_execution_end" && typeof value.toolCallId === "string" && typeof value.toolName === "string" && typeof value.isError === "boolean") {
		return { type: "tool_execution_end", toolCallId: bytePrefix(value.toolCallId, 500), toolName: bytePrefix(value.toolName, 500), isError: value.isError, result: { content: [] } };
	}
	return undefined;
}

function bytePrefix(value: string, maxBytes: number): string {
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

/** Strict LF-delimited RPC transport around an already spawned Pi process. */
export class RpcProcessClient {
	private readonly decoder = new StringDecoder("utf8");
	private readonly listeners = new Set<(event: RpcProcessEvent) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private buffer = "";
	private nextRequestId = 1;
	private closedError: Error | undefined;
	private terminationRequested = false;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly options: {
			maxFrameBytes?: number;
			absoluteMaxFrameBytes?: number;
			terminateProcess?: () => void;
			onStderr?: (text: string) => void;
			onExtensionUiRequest?: (request: Extract<RpcProcessEvent, { type: "extension_ui_request" }>) => boolean;
		} = {},
	) {
		child.stdout.on("data", this.handleData);
		child.stdout.on("end", this.handleEnd);
		child.stderr.on("data", this.handleStderr);
		child.once("error", this.handleError);
		child.once("close", this.handleClose);
		child.stdin.on("error", this.handleError);
	}

	onEvent(listener: (event: RpcProcessEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getState(): Promise<RpcSessionState> {
		return this.requestData<RpcSessionState>({ type: "get_state" });
	}

	async getSessionStats(): Promise<RpcSessionStats> {
		return this.requestData<RpcSessionStats>({ type: "get_session_stats" });
	}

	async getMessages(): Promise<unknown[]> {
		const data = await this.requestData<{ messages: unknown[] }>({ type: "get_messages" });
		return data.messages;
	}

	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const response = await this.request({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
		if (!response.success) throw new Error(response.error);
	}

	async steer(message: string): Promise<void> {
		const response = await this.request({ type: "steer", message });
		if (!response.success) throw new Error(response.error);
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	respondExtensionUi(id: string, response: { value: string } | { cancelled: true }): void {
		if (this.closedError || !this.child.stdin.writable || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
	}

	waitForSettled(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for subagent settlement after ${timeoutMs}ms.`));
			}, timeoutMs);
			const unsubscribe = this.onEvent((event) => {
				if (event.type === "transport_error") {
					clearTimeout(timeout);
					unsubscribe();
					reject(new Error(event.message));
					return;
				}
				if (event.type !== "agent_settled") return;
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			});
		});
	}

	async request(command: RpcCommandBody, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RpcResponse> {
		if (this.closedError) throw this.closedError;
		if (!this.child.stdin.writable || this.child.stdin.destroyed) throw new Error("Subagent RPC stdin is not writable.");
		const id = `subagent_${this.nextRequestId++}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${command.type}.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pending.delete(id);
				pending.reject(error);
			});
		});
	}

	dispose(): void {
		this.child.stdout.off("data", this.handleData);
		this.child.stdout.off("end", this.handleEnd);
		this.child.stderr.off("data", this.handleStderr);
		this.child.off("error", this.handleError);
		this.child.off("close", this.handleClose);
		this.child.stdin.off("error", this.handleError);
		this.fail(new Error("Subagent RPC client disposed."));
		this.listeners.clear();
	}

	private async requestData<T>(command: RpcCommandBody): Promise<T> {
		const response = await this.request(command);
		if (!response.success) throw new Error(response.error);
		if (!("data" in response)) throw new Error(`RPC response to ${command.type} did not contain data.`);
		return response.data as T;
	}

	private readonly handleData = (chunk: Buffer | string): void => {
		if (this.closedError) return;
		const absoluteMax = this.options.absoluteMaxFrameBytes ?? DEFAULT_ABSOLUTE_MAX_FRAME_BYTES;
		const hasNewline = typeof chunk === "string" ? chunk.includes("\n") : chunk.includes(0x0a);
		const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
		if (!hasNewline && Buffer.byteLength(this.buffer, "utf8") + chunkBytes > absoluteMax) {
			this.fatal(new Error(`Subagent RPC partial frame exceeded absolute limit ${absoluteMax} bytes.`));
			return;
		}
		const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		let offset = 0;
		while (offset <= decoded.length) {
			const newline = decoded.indexOf("\n", offset);
			const segment = decoded.slice(offset, newline < 0 ? decoded.length : newline);
			if (Buffer.byteLength(this.buffer, "utf8") + Buffer.byteLength(segment, "utf8") > absoluteMax) {
				this.fatal(new Error(`Subagent RPC partial frame exceeded absolute limit ${absoluteMax} bytes.`));
				return;
			}
			this.buffer += segment;
			if (newline < 0) return;
			let line = this.buffer;
			this.buffer = "";
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
			if (this.closedError) return;
			offset = newline + 1;
			if (offset === decoded.length) return;
		}
	};

	private readonly handleEnd = (): void => {
		if (this.closedError) return;
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) this.fatal(new Error("Subagent RPC stream ended with an unterminated frame."));
		this.buffer = "";
	};

	private readonly handleStderr = (chunk: Buffer | string): void => {
		this.options.onStderr?.(chunk.toString());
	};

	private readonly handleError = (error: Error): void => {
		this.fail(new Error(`Subagent RPC process error: ${error.message}`));
	};

	private readonly handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
		this.fail(new Error(`Subagent RPC process closed (code=${code ?? "null"}, signal=${signal ?? "none"}).`));
	};

	private processLine(line: string): void {
		if (!line.trim() || this.closedError) return;
		let value: any;
		try {
			value = JSON.parse(line);
		} catch {
			this.fatal(new Error(`Invalid JSON from subagent: ${line.slice(0, 120)}`));
			return;
		}
		const frameBytes = Buffer.byteLength(line, "utf8");
		const normalMax = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		if (frameBytes > normalMax) {
			const normalized = normalizeKnownLargeRecord(value, normalMax);
			if (!normalized) {
				this.fatal(new Error(`Unexpected oversized subagent RPC ${value?.type ?? "record"}: ${frameBytes} bytes exceeds ${normalMax}.`));
				return;
			}
			value = normalized;
		}
		if (value.type === "response" && typeof value.id === "string") {
			const pending = this.pending.get(value.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(value.id);
			pending.resolve(value as RpcResponse);
			return;
		}
		if (value.type === "extension_ui_request" && typeof value.id === "string") {
			const request = value as Extract<RpcProcessEvent, { type: "extension_ui_request" }>;
			if (this.options.onExtensionUiRequest?.(request)) {
				this.emit(request);
				return;
			}
			if (["select", "confirm", "input", "editor"].includes(value.method)) this.respondExtensionUi(value.id, { cancelled: true });
		}
		if (value && typeof value.type === "string") this.emit(value as RpcProcessEvent);
	}

	private fatal(error: Error): void {
		if (this.closedError) return;
		this.buffer = "";
		this.fail(error);
		if (!this.terminationRequested) {
			this.terminationRequested = true;
			if (this.options.terminateProcess) this.options.terminateProcess();
			else this.child.kill("SIGTERM");
		}
	}

	private emit(event: RpcProcessEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private fail(error: Error): void {
		if (!this.closedError) {
			this.closedError = error;
			this.emit({ type: "transport_error", message: error.message });
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(this.closedError);
		}
		this.pending.clear();
	}
}
