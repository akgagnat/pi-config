import type { JsonValue, StopReason, Usage } from "@earendil-works/pi-ai";

export type ContextQuality = "exact" | "estimated" | "unknown";

/** Transport-neutral telemetry retained for inspection and RPC reconciliation. */
export type TelemetryEvent =
	| { type: "activity"; message: string; at: number }
	| { type: "status"; status: "initializing" | "working" | "done" | "failed" | "aborted"; at: number; message?: string }
	| { type: "turn-start"; turn: number; at: number }
	| { type: "turn-end"; turn: number; at: number }
	| { type: "text-delta"; contentIndex: number; delta: string; at: number }
	| { type: "thinking-delta"; contentIndex: number; delta: string; at: number }
	| { type: "assistant-message"; text: string; thinking?: string; at: number }
	| { type: "tool-start"; id: string; name: string; args: JsonValue; at: number }
	| { type: "tool-update"; id: string; partialResult: JsonValue; at: number }
	| { type: "tool-end"; id: string; name: string; isError: boolean; at: number }
	| { type: "usage"; usage: Usage; contextQuality: ContextQuality; at: number }
	| { type: "context"; tokens: number | null; contextWindow: number; percent: number | null; contextQuality: ContextQuality; at: number }
	| { type: "session-stats"; totalTokens: number; cost: number; at: number }
	| { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; at: number }
	| { type: "compaction"; phase: "start" | "end"; reason: string; at: number }
	| { type: "agent-end"; stopReason?: StopReason; errorMessage?: string; at: number };
