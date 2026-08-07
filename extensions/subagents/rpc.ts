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
	| { type: "extension_ui_request"; id: string; method: string }
	| { type: "transport_error"; message: string };

type RpcCommandBody = RpcCommand extends infer T ? T extends { id?: string } ? Omit<T, "id"> : never : never;

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1_000_000;

/** Strict LF-delimited RPC transport around an already spawned Pi process. */
export class RpcProcessClient {
	private readonly decoder = new StringDecoder("utf8");
	private readonly listeners = new Set<(event: RpcProcessEvent) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private buffer = "";
	private nextRequestId = 1;
	private closedError: Error | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly options: {
			maxFrameBytes?: number;
			onStderr?: (text: string) => void;
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

	async prompt(message: string): Promise<void> {
		await this.request({ type: "prompt", message });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
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
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		if (Buffer.byteLength(this.buffer, "utf8") > maxFrameBytes && !this.buffer.includes("\n")) {
			this.fail(new Error(`Subagent RPC frame exceeded ${maxFrameBytes} bytes.`));
			this.child.kill("SIGTERM");
			return;
		}
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
				this.fail(new Error(`Subagent RPC frame exceeded ${maxFrameBytes} bytes.`));
				this.child.kill("SIGTERM");
				return;
			}
			this.processLine(line);
		}
		if (Buffer.byteLength(this.buffer, "utf8") > maxFrameBytes) {
			this.fail(new Error(`Subagent RPC frame exceeded ${maxFrameBytes} bytes.`));
			this.child.kill("SIGTERM");
		}
	};

	private readonly handleEnd = (): void => {
		this.buffer += this.decoder.end();
		if (this.buffer) this.processLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
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
		if (!line.trim()) return;
		let value: any;
		try {
			value = JSON.parse(line);
		} catch {
			this.fail(new Error(`Invalid JSON from subagent: ${line.slice(0, 120)}`));
			this.child.kill("SIGTERM");
			return;
		}
		if (value.type === "response" && typeof value.id === "string") {
			const pending = this.pending.get(value.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(value.id);
			pending.resolve(value as RpcResponse);
			return;
		}
		if (
			value.type === "extension_ui_request"
			&& typeof value.id === "string"
			&& ["select", "confirm", "input", "editor"].includes(value.method)
		) {
			this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: value.id, cancelled: true })}\n`);
		}
		if (value && typeof value.type === "string") this.emit(value as RpcProcessEvent);
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
