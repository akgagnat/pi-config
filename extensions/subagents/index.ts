/*
 * Subagent extension design notes:
 * - This extension follows Pi's extension API shape: a default factory receives ExtensionAPI and registers commands/tools.
 * - Subagents are isolated by spawning a child `pi --mode rpc --no-session --no-extensions` process, appending the
 *   selected profile's Markdown body as a system prompt, and reducing streamed RPC events into a bounded job store.
 * - Agent profiles are Markdown files with frontmatter (`name`, `description`, optional `tools`, optional `model`) and the
 *   body as the system prompt. Config agents live in this repo's `agents/`; user agents in Pi's global agent dir;
 *   project agents in nearest `.pi/agents`.
 * - Project-local agents are repository-controlled instructions, so they require trusted projects and optional confirmation.
 * - Keep delegated work bounded: cap parallel tasks/output/logs, pass profile tools via `--tools`, use `--no-session`, and
 *   propagate parent aborts to child processes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { validateCwd } from "../../utils/cwd.ts";
import { extractTextResponse, truncateMiddle } from "../../utils/text.ts";
import { discoverAgents, type AgentProfile, type AgentScope, type AgentSource } from "./profiles.ts";
import { truncateOutput as truncateBoundedOutput } from "./output.ts";
import { isTrustedChildCwd } from "./policy.ts";
import { formatActivityStatus } from "./status.ts";
import { ResultDelivery } from "./result-delivery.ts";
import { type JobStatus, toJobSnapshot } from "./jobs.ts";
import { JobStore, type JobDeliveryMetadata, type JobModelMetadata } from "./job-store.ts";
import { RpcProcessClient, type RpcProcessEvent } from "./rpc.ts";
import { openSubagentInspector } from "./inspector.ts";

const MAX_PARALLEL_TASKS = 4;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const OUTPUT_CAP_BYTES = 20_000;
const OUTPUT_CAP_LINES = 600;
const LOG_CAP_CHARS = 40_000;
const JOB_TIMEOUT_MS = 15 * 60_000;

type AgentConfig = AgentProfile;
type SubagentJob = {
	id: string;
	name: string;
	agent: string;
	task: string;
	cwd: string;
	status: JobStatus;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	model?: string;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	output?: string;
	stderr: string;
	logs: string[];
	completion?: Promise<RunResult>;
	abortController: AbortController;
	abort?: () => void;
};

type RunResult = {
	id: string;
	name: string;
	agent: string;
	source?: AgentSource;
	task: string;
	status: JobStatus;
	exitCode: number;
	output: string;
	stderr: string;
	messages: Message[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
};

const TaskSchema = Type.Object({
	agent: Type.String({ description: "Agent profile name" }),
	task: Type.String({ description: "Task to delegate" }),
	name: Type.Optional(Type.String({ description: "Human-readable name for this subagent job" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this subagent" })),
	model: Type.Optional(Type.String({ description: "Model to use for this subagent job. Defaults to the main agent model." })),
});

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent profile name for single-task mode" })),
	task: Type.Optional(Type.String({ description: "Task for single-task mode" })),
	name: Type.Optional(Type.String({ description: "Human-readable name for the single subagent job" })),
	model: Type.Optional(Type.String({ description: "Model to use for the subagent. Defaults to the main agent model." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent." })),
	tasks: Type.Optional(Type.Array(TaskSchema, { description: "Small parallel batch of delegated tasks" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("config"), Type.Literal("user"), Type.Literal("project"), Type.Literal("all")], {
			description: "Agent profile scope. Default: config.",
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Ask before running project-local agents. Default: true." }),
	),
});

type SubagentParams = Static<typeof SubagentParamsSchema>;

const jobs = new Map<string, SubagentJob>();
const deliverySuppressed = new Set<string>();
const jobStore = new JobStore();
let nextJobNumber = 1;

function nowIso(): string {
	return new Date().toISOString().slice(11, 19);
}

function makeJobId(): string {
	return `sa-${String(nextJobNumber++).padStart(4, "0")}`;
}

function addJobLog(job: SubagentJob, line: string): void {
	const at = Date.now();
	job.logs.push(`[${nowIso()}] ${line}`);
	let combined = job.logs.join("\n");
	while (combined.length > LOG_CAP_CHARS && job.logs.length > 1) {
		job.logs.shift();
		combined = job.logs.join("\n");
	}
	job.updatedAt = at;
	if (jobStore.get(job.id)) {
		jobStore.appendTimeline(job.id, { type: "activity", message: line, at });
		jobStore.update(job.id, {
			status: job.status,
			...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
			...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
			...(job.stopReason === undefined ? {} : { stopReason: job.stopReason }),
			...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
		});
	}
}

function createJob(
	agent: string,
	task: string,
	cwd: string,
	requestedName?: string,
	metadata: {
		parentSessionId?: string;
		toolCallId?: string;
		model?: JobModelMetadata;
		delivery?: JobDeliveryMetadata;
	} = {},
): SubagentJob {
	const id = makeJobId();
	const taskPreview = task.replace(/\s+/g, " ").trim().slice(0, 48);
	const name = requestedName?.trim() || `${agent}:${taskPreview || id}`;
	const startedAt = Date.now();
	const job: SubagentJob = {
		id,
		name,
		agent,
		task,
		cwd,
		status: "initializing",
		startedAt,
		updatedAt: startedAt,
		stderr: "",
		logs: [],
		abortController: new AbortController(),
	};
	jobStore.create({
		id,
		name,
		agent,
		task,
		cwd,
		parent: { sessionId: metadata.parentSessionId, toolCallId: metadata.toolCallId },
		model: metadata.model ?? { source: "default" },
		delivery: metadata.delivery ?? { mode: "foreground", method: "tool-result", consumedByWait: false },
		startedAt,
	});
	job.abort = () => {
		if (job.status === "done" || job.status === "failed" || job.status === "aborted" || job.abortController.signal.aborted) return;
		job.updatedAt = Date.now();
		addJobLog(job, "cancellation requested");
		job.abortController.abort();
	};
	addJobLog(job, `created job ${id} (${name})`);
	jobs.set(id, job);
	return job;
}

function findJob(query: string): SubagentJob | undefined {
	return jobs.get(query) ?? [...jobs.values()].find((job) => job.name === query);
}

function formatDuration(startedAt: number, finishedAt = Date.now()): string {
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function formatJobSummary(job: SubagentJob): string {
	const duration = formatDuration(job.startedAt, job.finishedAt);
	const suffix = job.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
	return `- ${job.id} ${job.status.padEnd(12)} ${job.name} [${job.agent}] ${duration}${suffix}`;
}

function recentJobs(): SubagentJob[] {
	return [...jobs.values()]
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, 20);
}

function pruneCompletedJobs(): void {
	const completed = [...jobs.values()]
		.filter((job) => job.status === "done" || job.status === "failed" || job.status === "aborted")
		.sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
	for (const job of completed.slice(20)) {
		jobs.delete(job.id);
		deliverySuppressed.delete(job.id);
	}
}

function formatStatusBlock(activeResults?: RunResult[]): string {
	const activeIds = new Set(activeResults?.map((result) => result.id));
	const recent = recentJobs();
	if (recent.length === 0) return "No subagent jobs yet.";
	return recent
		.map((job) => `${activeIds.has(job.id) ? "*" : " "} ${formatJobSummary(job)}`)
		.join("\n");
}

function formatJobLog(job: SubagentJob): string {
	return [
		`${job.id} ${job.name}`,
		`agent: ${job.agent}`,
		`status: ${job.status}`,
		`cwd: ${job.cwd}`,
		`duration: ${formatDuration(job.startedAt, job.finishedAt)}`,
		job.model ? `model: ${job.model}` : "",
		job.exitCode !== undefined ? `exit: ${job.exitCode}` : "",
		job.stopReason ? `stopReason: ${job.stopReason}` : "",
		"",
		"Task:",
		job.task,
		"",
		"Log:",
		job.logs.join("\n") || "(no log)",
		job.output ? `\nOutput:\n${job.output}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function selectSubagentJob(ctx: ExtensionContext): Promise<string | null> {
	const recent = recentJobs();
	if (recent.length === 0) {
		ctx.ui.notify("No subagent jobs yet.", "info");
		return null;
	}
	const items: SelectItem[] = recent.map((job) => ({
		value: job.id,
		label: `${job.id} ${job.name}`,
		description: `${job.status} · ${job.agent} · ${formatDuration(job.startedAt, job.finishedAt)}`,
	}));
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent jobs")), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter view log • esc close"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const runtime = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(runtime) ? { command: "pi", args } : { command: process.execPath, args };
}

function getFinalAssistantOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return extractTextResponse(message.content);
	}
	return "";
}

function resolveJobModel(
	taskModel: string | undefined,
	requestModel: string | undefined,
	profileModel: string | undefined,
	parentModel: string | undefined,
): JobModelMetadata {
	const choices = [
		[taskModel, "task"],
		[requestModel, "request"],
		[profileModel, "profile"],
		[parentModel, "parent"],
	] as const;
	for (const [candidate, source] of choices) {
		const requested = candidate?.trim();
		if (requested) return { requested, source };
	}
	return { source: "default" };
}

function logJsonEvent(job: SubagentJob, event: any): void {
	if (event.type === "message_start" && event.message?.role) {
		addJobLog(job, `message_start ${event.message.role}`);
		return;
	}
	if (event.type === "message_end" && event.message?.role) {
		const message = event.message as Message;
		if (message.role === "assistant") {
			const text = truncateMiddle(getFinalAssistantOutput([message]), 500);
			addJobLog(job, text ? `assistant: ${text}` : "assistant message_end");
			return;
		}
		addJobLog(job, `message_end ${message.role}`);
		return;
	}
	if (event.type === "tool_execution_start" || event.type === "tool_call") {
		addJobLog(job, `tool ${event.toolName ?? "unknown"} started`);
		return;
	}
	if (event.type === "tool_execution_end" || event.type === "tool_result_end") {
		addJobLog(job, `tool ${event.toolName ?? "unknown"} finished`);
		return;
	}
	if (event.type === "agent_start") addJobLog(job, "agent_start");
	if (event.type === "agent_end") addJobLog(job, "agent_end");
}

function recordRpcEvent(job: SubagentJob, result: RunResult, event: RpcProcessEvent): void {
	const at = Date.now();
	if (event.type === "transport_error") {
		addJobLog(job, event.message);
		return;
	}
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta") {
			jobStore.appendTimeline(job.id, { type: "text-delta", contentIndex: update.contentIndex, delta: update.delta, at });
		} else if (update.type === "thinking_delta") {
			jobStore.appendTimeline(job.id, { type: "thinking-delta", contentIndex: update.contentIndex, delta: update.delta, at });
		}
		return;
	}
	if (event.type === "message_end") {
		const message = event.message as Message;
		result.messages.push(message);
		if (result.messages.length > 100) result.messages.shift();
		if (message.role === "assistant") {
			result.model = message.model ?? result.model;
			result.stopReason = message.stopReason;
			result.errorMessage = message.errorMessage;
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const thinking = message.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n");
			jobStore.appendTimeline(job.id, { type: "assistant-message", text, ...(thinking ? { thinking } : {}), at });
			if (message.usage) jobStore.appendTimeline(job.id, { type: "usage", usage: message.usage, contextQuality: "exact", at });
		}
		logJsonEvent(job, event);
		return;
	}
	if (event.type === "turn_start") {
		const turn = (jobStore.get(job.id)?.timeline.filter((item) => item.type === "turn-start").length ?? 0) + 1;
		jobStore.appendTimeline(job.id, { type: "turn-start", turn, at });
		return;
	}
	if (event.type === "turn_end") {
		const turn = jobStore.get(job.id)?.timeline.filter((item) => item.type === "turn-start").length ?? 0;
		jobStore.appendTimeline(job.id, { type: "turn-end", turn, at });
		return;
	}
	if (event.type === "tool_execution_start") {
		jobStore.appendTimeline(job.id, { type: "tool-start", id: event.toolCallId, name: event.toolName, args: event.args, at });
		addJobLog(job, `tool ${event.toolName} started`);
		return;
	}
	if (event.type === "tool_execution_update") {
		jobStore.appendTimeline(job.id, { type: "tool-update", id: event.toolCallId, partialResult: event.partialResult, at });
		return;
	}
	if (event.type === "tool_execution_end") {
		jobStore.appendTimeline(job.id, { type: "tool-end", id: event.toolCallId, name: event.toolName, isError: event.isError, at });
		addJobLog(job, `tool ${event.toolName} finished${event.isError ? " with error" : ""}`);
		return;
	}
	if (event.type === "auto_retry_start") {
		jobStore.appendTimeline(job.id, { type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, at });
		return;
	}
	if (event.type === "compaction_start" || event.type === "compaction_end") {
		jobStore.appendTimeline(job.id, { type: "compaction", phase: event.type === "compaction_start" ? "start" : "end", reason: event.reason, at });
	}
}

async function runRpcAgent(
	cwd: string,
	agent: AgentConfig,
	job: SubagentJob,
	taskCwd: string | undefined,
	modelMetadata: JobModelMetadata,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	let tempDir: string | undefined;
	const result: RunResult = {
		id: job.id,
		name: job.name,
		agent: agent.name,
		source: agent.source,
		task: job.task,
		status: "failed",
		exitCode: 1,
		output: "",
		stderr: "",
		messages: [],
		model: modelMetadata.requested,
	};
	let child: ReturnType<typeof spawn> | undefined;
	let client: RpcProcessClient | undefined;
	let wasAborted = false;
	let statsRefreshPending = false;
	let unsubscribeRpc: (() => void) | undefined;
	let abortSignal: AbortSignal | undefined;
	let abortHandler: (() => void) | undefined;
	let terminateTimer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	try {
		tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
		const promptPath = join(tempDir, `${agent.name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.md`);
		await writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
		const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--name", job.name, "--append-system-prompt", promptPath];
		if (modelMetadata.requested) args.push("--model", modelMetadata.requested);
		args.push("--tools", (agent.tools?.length ? agent.tools : DEFAULT_TOOLS).join(","));
		const invocation = getPiInvocation(args);
		addJobLog(job, `spawn ${invocation.command} ${invocation.args.join(" ")}`);
		child = spawn(invocation.command, invocation.args, {
			cwd: taskCwd ?? cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SUBAGENT: "1", PI_SUBAGENT_ID: job.id, PI_SUBAGENT_NAME: job.name },
		});
		client = new RpcProcessClient(child as ChildProcessWithoutNullStreams, {
			onStderr: (text) => {
				result.stderr = (result.stderr + text).slice(-LOG_CAP_CHARS);
				job.stderr = (job.stderr + text).slice(-LOG_CAP_CHARS);
				jobStore.appendStderr(job.id, text);
			},
		});
		const refreshStats = () => {
			if (!client || statsRefreshPending) return;
			statsRefreshPending = true;
			void client.getSessionStats().then((stats) => {
				jobStore.appendTimeline(job.id, { type: "session-stats", totalTokens: stats.tokens.total, cost: stats.cost, at: Date.now() });
				if (stats.contextUsage) jobStore.appendTimeline(job.id, { type: "context", ...stats.contextUsage, contextQuality: stats.contextUsage.tokens === null ? "unknown" : "estimated", at: Date.now() });
			}).catch(() => {}).finally(() => { statsRefreshPending = false; });
		};
		unsubscribeRpc = client.onEvent((event) => {
			recordRpcEvent(job, result, event);
			if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "compaction_end") refreshStats();
		});
		const state = await client.getState();
		if (state.model) {
			job.model = `${state.model.provider}/${state.model.id}`;
			result.model = job.model;
			jobStore.update(job.id, { model: { ...modelMetadata, provider: state.model.provider, id: state.model.id, contextWindow: state.model.contextWindow, thinkingLevel: state.thinkingLevel } });
		}
		job.status = "working";
		addJobLog(job, `working in ${taskCwd ?? cwd}`);
		abortSignal = signal ? AbortSignal.any([signal, job.abortController.signal]) : job.abortController.signal;
		let promptAccepted = false;
		let abortRequested = false;
		abortHandler = () => {
			if (abortRequested) return;
			abortRequested = true;
			wasAborted = true;
			addJobLog(job, "abort requested");
			if (promptAccepted) void client?.abort().catch(() => {});
			terminateTimer = setTimeout(() => {
				if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			}, 1_000);
			killTimer = setTimeout(() => {
				if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 6_000);
			terminateTimer.unref();
			killTimer.unref();
		};
		if (abortSignal.aborted) abortHandler();
		else abortSignal.addEventListener("abort", abortHandler, { once: true });
		if (abortRequested) throw new Error("Subagent was aborted before prompting.");
		const settled = client.waitForSettled(JOB_TIMEOUT_MS);
		void settled.catch(() => {});
		await client.prompt(`Task: ${job.task}`);
		promptAccepted = true;
		if (abortRequested) await client.abort().catch(() => {});
		await settled;
		const stats = await client.getSessionStats().catch(() => undefined);
		if (stats) {
			jobStore.appendTimeline(job.id, { type: "session-stats", totalTokens: stats.tokens.total, cost: stats.cost, at: Date.now() });
			if (stats.contextUsage) jobStore.appendTimeline(job.id, { type: "context", ...stats.contextUsage, contextQuality: stats.contextUsage.tokens === null ? "unknown" : "estimated", at: Date.now() });
		}
		result.exitCode = 0;
		result.output = truncateBoundedOutput(getFinalAssistantOutput(result.messages) || result.errorMessage || result.stderr || "(no output)", { maxBytes: OUTPUT_CAP_BYTES, maxLines: OUTPUT_CAP_LINES }).text;
		if (wasAborted) result.stopReason = "aborted";
		result.status = wasAborted ? "aborted" : result.stopReason === "error" ? "failed" : "done";
	} catch (error) {
		if (!wasAborted) void client?.abort().catch(() => {});
		const errorMessage = error instanceof Error ? error.message : String(error);
		result.status = wasAborted || signal?.aborted || job.abortController.signal.aborted ? "aborted" : "failed";
		result.stopReason = result.status === "aborted" ? "aborted" : "error";
		result.errorMessage = errorMessage;
		result.output = result.status === "aborted" ? "Cancelled." : errorMessage;
	} finally {
		if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
		if (terminateTimer) clearTimeout(terminateTimer);
		if (killTimer) clearTimeout(killTimer);
		unsubscribeRpc?.();
		client?.dispose();
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			setTimeout(() => child?.kill("SIGKILL"), 5_000).unref();
		}
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
	job.status = result.status;
	job.exitCode = result.exitCode;
	job.output = result.output;
	job.model = result.model;
	job.stopReason = result.stopReason;
	job.errorMessage = result.errorMessage;
	job.finishedAt = Date.now();
	job.updatedAt = job.finishedAt;
	job.abort = undefined;
	const fullOutput = getFinalAssistantOutput(result.messages) || result.errorMessage || result.stderr || result.output;
	const stored = jobStore.setOutput(job.id, fullOutput);
	jobStore.update(job.id, {
		delivery: {
			...stored.delivery,
			originalOutputBytes: Buffer.byteLength(fullOutput, "utf8"),
			deliveredOutputBytes: Buffer.byteLength(result.output, "utf8"),
			outputTruncated: Buffer.byteLength(fullOutput, "utf8") > Buffer.byteLength(result.output, "utf8"),
		},
	});
	addJobLog(job, `${job.status} exit=${job.exitCode}`);
	pruneCompletedJobs();
	return result;
}

function isFailure(result: RunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function resultDetails(result: RunResult) {
	return {
		id: result.id,
		name: result.name,
		agent: result.agent,
		status: result.status,
		exitCode: result.exitCode,
		...(result.model === undefined ? {} : { model: result.model }),
		...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
		...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	const resultDelivery = new ResultDelivery<RunResult>();
	let sessionContext: ExtensionContext | undefined;
	const updateStatus = () => {
		const values = [...jobs.values()];
		sessionContext?.ui.setStatus("subagents", formatActivityStatus({
			running: values.filter((job) => job.status === "initializing" || job.status === "working").length,
			done: values.filter((job) => job.status === "done").length,
			failed: values.filter((job) => job.status === "failed" || job.status === "aborted").length,
		}));
	};
	const flushResults = () => {
		for (const result of resultDelivery.drain()) {
			pi.sendMessage({
				customType: "subagent-result",
				content: `Subagent ${result.id} (${result.name}) ${result.status}.\n\n${result.output}`,
				display: true,
				details: { id: result.id, status: result.status },
			}, { deliverAs: "followUp", triggerTurn: true });
		}
	};
	pi.on("session_start", (_event, ctx) => { sessionContext = ctx; updateStatus(); });
	pi.on("agent_end", () => { flushResults(); });
	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			if (job.abort) deliverySuppressed.add(job.id);
			job.abort?.();
		}
		sessionContext?.ui.setStatus("subagents", undefined);
		sessionContext = undefined;
		resultDelivery.clear();
	});

	const startBackground = async (toolCallId: string, params: SubagentParams, ctx: ExtensionContext) => {
		const scope = params.scope ?? "config";
		const agents = discoverAgents(ctx.cwd, scope);
		if (!params.agent || !params.task) throw new Error("agent and task are required.");
		if ((scope === "project" || scope === "all") && !ctx.isProjectTrusted()) {
			throw new Error("Project-local subagents require a trusted project.");
		}
		if ((scope === "project" || scope === "all") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
			const projectNames = agents.filter((agent) => agent.source === "project").map((agent) => agent.name);
			if (projectNames.length > 0 && !(await ctx.ui.confirm("Run project-local subagents?", `Project agents are repository-controlled instructions. Agents: ${projectNames.join(", ")}`))) {
				throw new Error("Canceled.");
			}
		}
		const cwdResult = validateCwd(ctx.cwd, params.cwd);
		if (cwdResult.error) throw new Error(cwdResult.error);
		if (!isTrustedChildCwd(ctx.cwd, cwdResult.cwd)) throw new Error("cwd must be the trusted project directory or one of its descendants.");
		const agent = agents.find((candidate) => candidate.name === params.agent);
		if (!agent) throw new Error(`Unknown agent. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
		const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const model = resolveJobModel(params.model, undefined, agent.model, inheritedModel);
		const job = createJob(params.agent, params.task, cwdResult.cwd, params.name, {
			parentSessionId: ctx.sessionManager.getSessionId(),
			toolCallId,
			model,
			delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false },
		});
		// Background jobs outlive the parent tool turn; explicit subagent_cancel owns their cancellation.
		job.completion = runRpcAgent(ctx.cwd, agent, job, cwdResult.cwd, model, undefined);
		job.completion.then((result) => {
			pruneCompletedJobs();
			updateStatus();
			if (deliverySuppressed.has(result.id)) return;
			resultDelivery.defer(result);
			if (sessionContext?.isIdle()) flushResults();
		}, (error) => {
			addJobLog(job, `completion failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		return job;
	};

	pi.registerCommand("subagents", {
		description: "List available subagent profiles",
		handler: async (args, ctx) => {
			const scope = (args.trim() || "config") as NonNullable<SubagentParams["scope"]>;
			if (!["config", "user", "project", "all"].includes(scope)) {
				ctx.ui.notify("Usage: /subagents [config|user|project|all]", "warning");
				return;
			}
			const agents = discoverAgents(ctx.cwd, scope);
			const text = agents.length
				? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}\n  ${a.filePath}`).join("\n")
				: `No subagents found for scope: ${scope}`;
			await ctx.ui.editor(`Subagents: ${scope}`, text);
		},
	});

	pi.registerCommand("subagents-status", {
		description: "Browse recent subagent jobs and their logs",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				await ctx.ui.editor("Subagent jobs", formatStatusBlock());
				return;
			}
			await openSubagentInspector(ctx, jobStore);
		},
	});

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description: "Start a named profile subagent in the background. Its result is available through subagent_wait; use subagent_check or subagent_list while it runs.",
		promptSnippet: "Start a self-contained profile subagent in the background.",
		promptGuidelines: [
			"Use subagent_spawn for independent work that can continue while you work on other tasks.",
			"Give subagent_spawn a self-contained task with relevant paths and the expected report.",
		],
		parameters: Type.Intersect([SubagentParamsSchema, Type.Object({ agent: Type.String(), task: Type.String() })]),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const active = [...jobs.values()].filter((job) => job.status === "initializing" || job.status === "working").length;
			if (active >= MAX_PARALLEL_TASKS) throw new Error(`Too many running subagents. Max is ${MAX_PARALLEL_TASKS}.`);
			const job = await startBackground(toolCallId, params, ctx);
			updateStatus();
			return { content: [{ type: "text", text: `Spawned ${job.id} (${job.name}). Continue working; use subagent_wait when its result is needed.` }], details: { id: job.id, status: job.status } };
		},
	});

	pi.registerTool({
		name: "subagent_check",
		label: "Check Subagent",
		description: "Inspect a background subagent's status and recent log without waiting.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent job id" }) }),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) throw new Error(`Unknown subagent job: ${params.id}`);
			return { content: [{ type: "text", text: `${formatJobSummary(job)}\n\n${job.logs.slice(-10).join("\n") || "(no log yet)"}` }], details: { id: job.id, status: job.status } };
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description: "List running and recently completed background subagents.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: formatStatusBlock() }], details: { jobs: [...jobs.values()].map(toJobSnapshot) } };
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagents",
		description: "Wait for specified background subagents and return their final reports.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, description: "Subagent job ids" }) }),
		async execute(_toolCallId, params, signal, onUpdate) {
			const selected = params.ids.map((id) => {
				const job = jobs.get(id);
				if (!job?.completion) throw new Error(`Unknown subagent job: ${id}`);
				return job;
			});
			if (signal?.aborted) throw new Error("Wait aborted. Subagents keep running.");
			resultDelivery.consume(params.ids);
			for (const job of selected) {
				const snapshot = jobStore.get(job.id);
				if (snapshot) jobStore.update(job.id, { delivery: { ...snapshot.delivery, method: "subagent-wait", consumedByWait: true } });
			}
			onUpdate?.({ content: [{ type: "text", text: `Waiting for ${params.ids.join(", ")}...` }], details: { ids: params.ids } });
			const completion = Promise.all(selected.map((job) => job.completion!));
			let abortWait: (() => void) | undefined;
			const aborted = signal ? new Promise<never>((_resolve, reject) => {
				abortWait = () => reject(new Error("Wait aborted. Subagents keep running."));
				signal.addEventListener("abort", abortWait, { once: true });
			}) : undefined;
			let results: RunResult[];
			try {
				results = aborted ? await Promise.race([completion, aborted]) : await completion;
			} finally {
				if (signal && abortWait) signal.removeEventListener("abort", abortWait);
			}
			return {
				content: [{ type: "text", text: results.map((result) => `## ${result.id} ${result.name} — ${result.status}\n\n${result.output}`).join("\n\n---\n\n") }],
				details: { results: results.map(resultDetails) },
				isError: results.some(isFailure),
			};
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel Subagents",
		description: "Cancel running background subagents while preserving their partial logs.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, description: "Subagent job ids" }) }),
		async execute(_toolCallId, params) {
			const lines = params.ids.map((id) => {
				const job = jobs.get(id);
				if (!job) throw new Error(`Unknown subagent job: ${id}`);
				if (!job.abort) return `${id} was already ${job.status}.`;
				job.abort();
				return `Cancellation requested for ${id}.`;
			});
			updateStatus();
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ids: params.ids } };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent", 
		description:
			"Delegate one task, or a small parallel batch, to named Markdown-defined Pi subagents with isolated context. Default scope is config agents from this pi-config repo.",
		promptSnippet: "Delegate isolated research, review, or exploration work to a named subagent profile.",
		promptGuidelines: [
			"Use subagent when independent research/review/exploration can be done in an isolated context window.",
			"Give each subagent job a short descriptive name when launching multiple subagents.",
			"Use subagent only with a specific, self-contained task and include relevant paths or constraints.",
		],
		parameters: SubagentParamsSchema,
		async execute(toolCallId, params: SubagentParams, signal, onUpdate, ctx) {
			const scope = params.scope ?? "config";
			const agents = discoverAgents(ctx.cwd, scope);
			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = Boolean(params.tasks?.length);
			if (Number(hasSingle) + Number(hasParallel) !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one mode: agent+task or tasks[]." }],
					details: { availableAgents: agents },
					isError: true,
				};
			}

			if ((scope === "project" || scope === "all") && !ctx.isProjectTrusted()) {
				return {
					content: [{ type: "text", text: "Project-local subagents require a trusted project." }],
					details: { mode: "none" },
					isError: true,
				};
			}

			if ((scope === "project" || scope === "all") && (params.confirmProjectAgents ?? true)) {
				const projectNames = agents.filter((agent) => agent.source === "project").map((agent) => agent.name);
				if (projectNames.length > 0 && ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Run project-local subagents?",
						`Project agents are repository-controlled instructions. Agents: ${projectNames.join(", ")}`,
					);
					if (!ok) return { content: [{ type: "text", text: "Canceled." }], details: { mode: "none" } };
				}
			}

			const run = async (item: { agent: string; task: string; cwd?: string; name?: string; model?: string }) => {
				const cwdResult = validateCwd(ctx.cwd, item.cwd);
				const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const profile = agents.find((candidate) => candidate.name === item.agent);
				const model = resolveJobModel(item.model, params.model, profile?.model, inheritedModel);
				const job = createJob(item.agent, item.task, cwdResult.cwd, item.name, {
					parentSessionId: ctx.sessionManager.getSessionId(),
					toolCallId,
					model,
					delivery: { mode: params.tasks?.length ? "batch" : "foreground", method: "tool-result", consumedByWait: false },
				});
				const active = [...jobs.values()].filter((candidate) => candidate.status === "initializing" || candidate.status === "working").length;
				if (active > MAX_PARALLEL_TASKS) {
					const output = `Too many running subagents. Max is ${MAX_PARALLEL_TASKS}.`;
					job.status = "failed";
					job.output = output;
					job.exitCode = 1;
					job.finishedAt = Date.now();
					jobStore.setOutput(job.id, output);
					addJobLog(job, output);
					return { id: job.id, name: job.name, agent: item.agent, task: item.task, status: "failed", exitCode: 1, output, stderr: "", messages: [] } satisfies RunResult;
				}
				if (cwdResult.error || !isTrustedChildCwd(ctx.cwd, cwdResult.cwd)) {
					const error = cwdResult.error ?? "cwd must be the trusted project directory or one of its descendants.";
					job.status = "failed";
					job.output = error;
					job.exitCode = 1;
					job.finishedAt = Date.now();
					jobStore.setOutput(job.id, error);
					addJobLog(job, error);
					return {
						id: job.id,
						name: job.name,
						agent: item.agent,
						task: item.task,
						status: "failed",
						exitCode: 1,
						output: error,
						stderr: "",
						messages: [],
					} satisfies RunResult;
				}
				const agent = profile;
				if (!agent) {
					const output = `Unknown agent. Available: ${agents.map((a) => a.name).join(", ") || "none"}`;
					job.status = "failed";
					job.output = output;
					job.exitCode = 1;
					job.finishedAt = Date.now();
					jobStore.setOutput(job.id, output);
					addJobLog(job, output);
					return {
						id: job.id,
						name: job.name,
						agent: item.agent,
						task: item.task,
						status: "failed",
						exitCode: 1,
						output,
						stderr: "",
						messages: [],
					} satisfies RunResult;
				}
				return runRpcAgent(ctx.cwd, agent, job, cwdResult.cwd, model, signal);
			};

			if (hasSingle) {
				onUpdate?.({
					content: [{ type: "text", text: `Starting ${params.name ?? params.agent}...` }],
					details: { mode: "single", jobs: formatStatusBlock() },
				});
				const result = await run({ agent: params.agent!, task: params.task!, cwd: params.cwd, name: params.name, model: params.model });
				return {
					content: [{ type: "text", text: `Subagent ${result.id} (${result.name}) ${result.status}\n\n${result.output}` }],
					details: { mode: "single", result: resultDetails(result) },
					isError: isFailure(result),
				};
			}

			const tasks = params.tasks ?? [];
			if (tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: { mode: "parallel", results: [] },
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Starting ${tasks.length} subagents...` }],
				details: { mode: "parallel", jobs: formatStatusBlock() },
			});
			const results = await Promise.all(
				tasks.map(async (task) => {
					const result = await run(task);
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `${result.id} (${result.name}) ${result.status}\n\n${formatStatusBlock([result])}`,
							},
						],
						details: { mode: "parallel", jobs: formatStatusBlock([result]) },
					});
					return result;
				}),
			);
			const succeeded = results.filter((result) => !isFailure(result)).length;
			return {
				content: [
					{
						type: "text",
						text: `Parallel subagents: ${succeeded}/${results.length} succeeded\n\n${results
							.map(
								(result) =>
									`## ${result.id} ${result.name} — ${result.status}\n\nAgent: ${result.agent}\n\n${result.output}`,
							)
							.join("\n\n---\n\n")}`,
					},
				],
				details: {
					mode: "parallel",
					results: results.map(resultDetails),
					jobs: results.map((result) => toJobSnapshot(jobs.get(result.id)!)),
				},
				isError: succeeded !== results.length,
			};
		},
	});
}
