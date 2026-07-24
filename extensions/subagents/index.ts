/*
 * Subagent extension design notes:
 * - This extension follows Pi's extension API shape: a default factory receives ExtensionAPI and registers commands/tools.
 * - Subagents are isolated by spawning a child `pi --mode json -p --no-session` process, appending the selected profile's
 *   Markdown body as a system prompt, and parsing JSON events from stdout for assistant messages, logs, and status.
 * - Agent profiles are Markdown files with frontmatter (`name`, `description`, optional `tools`, optional `model`) and the
 *   body as the system prompt. Config agents live in this repo's `agents/`; user agents in Pi's global agent dir;
 *   project agents in nearest `.pi/agents`.
 * - Project-local agents are repository-controlled instructions, so they require trusted projects and optional confirmation.
 * - Keep delegated work bounded: cap parallel tasks/output/logs, pass profile tools via `--tools`, use `--no-session`, and
 *   propagate parent aborts to child processes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { validateCwd } from "../../utils/cwd.ts";
import { extractTextResponse, truncateMiddle } from "../../utils/text.ts";
import { discoverAgents, type AgentProfile, type AgentScope, type AgentSource } from "./profiles.ts";
import { ResultDelivery } from "./result-delivery.ts";

const MAX_PARALLEL_TASKS = 4;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const OUTPUT_CAP_CHARS = 20_000;
const LOG_CAP_CHARS = 40_000;

type JobStatus = "initializing" | "working" | "done" | "failed" | "aborted";

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
let nextJobNumber = 1;

function nowIso(): string {
	return new Date().toISOString().slice(11, 19);
}

function makeJobId(): string {
	return `sa-${String(nextJobNumber++).padStart(4, "0")}`;
}

function addJobLog(job: SubagentJob, line: string): void {
	job.logs.push(`[${nowIso()}] ${line}`);
	let combined = job.logs.join("\n");
	while (combined.length > LOG_CAP_CHARS && job.logs.length > 1) {
		job.logs.shift();
		combined = job.logs.join("\n");
	}
	job.updatedAt = Date.now();
}

function createJob(agent: string, task: string, cwd: string, requestedName?: string): SubagentJob {
	const id = makeJobId();
	const taskPreview = task.replace(/\s+/g, " ").trim().slice(0, 48);
	const name = requestedName?.trim() || `${agent}:${taskPreview || id}`;
	const job: SubagentJob = {
		id,
		name,
		agent,
		task,
		cwd,
		status: "initializing",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		stderr: "",
		logs: [],
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

function formatStatusBlock(activeResults?: RunResult[]): string {
	const activeIds = new Set(activeResults?.map((result) => result.id));
	const recent = [...jobs.values()]
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, 20);
	if (recent.length === 0) return "No subagent jobs yet.";
	return recent
		.map((job) => `${activeIds.has(job.id) ? "*" : " "} ${formatJobSummary(job)}`)
		.join("\n");
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

function truncateOutput(text: string): string {
	return text.length <= OUTPUT_CAP_CHARS
		? text
		: `${text.slice(0, OUTPUT_CAP_CHARS)}\n\n[Output truncated after ${OUTPUT_CAP_CHARS} characters.]`;
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

async function runAgent(
	cwd: string,
	agent: AgentConfig,
	job: SubagentJob,
	taskCwd: string | undefined,
	requestedModel: string | undefined,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
	const promptPath = join(tempDir, `${agent.name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.md`);
	await writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });

	const model = requestedModel?.trim() || agent.model?.trim() || process.env.PI_MODEL?.trim();
	job.model = model;

	const args = ["--mode", "json", "-p", "--no-session", "--name", job.name, "--append-system-prompt", promptPath];
	if (model) args.push("--model", model);
	args.push("--tools", (agent.tools?.length ? agent.tools : DEFAULT_TOOLS).join(","));
	args.push(`Task: ${job.task}`);

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
		model,
	};

	try {
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			addJobLog(job, `spawn ${invocation.command} ${invocation.args.slice(0, -1).join(" ")} <task>`);
			const child = spawn(invocation.command, invocation.args, {
				cwd: taskCwd ?? cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT: "1", PI_SUBAGENT_ID: job.id, PI_SUBAGENT_NAME: job.name },
			});
			job.status = "working";
			job.updatedAt = Date.now();
			addJobLog(job, `working in ${taskCwd ?? cwd}`);

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					addJobLog(job, `stdout: ${truncateMiddle(line, 500)}`);
					return;
				}
				logJsonEvent(job, event);
				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					result.messages.push(message);
					if (message.role === "assistant") {
						result.model = message.model ?? result.model;
						result.stopReason = message.stopReason;
						result.errorMessage = message.errorMessage;
					}
				}
			};

			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data) => {
				const text = data.toString();
				result.stderr += text;
				job.stderr += text;
				addJobLog(job, `stderr: ${truncateMiddle(text.trim(), 500)}`);
			});
			child.on("error", (error) => {
				result.errorMessage = error.message;
				addJobLog(job, `process error: ${error.message}`);
				resolve(1);
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			const abort = () => {
				wasAborted = true;
				job.status = "aborted";
				addJobLog(job, "abort requested");
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
			};
			job.abort = abort;
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});

		result.exitCode = exitCode;
		result.output = truncateOutput(getFinalAssistantOutput(result.messages) || result.errorMessage || result.stderr || "(no output)");
		if (wasAborted) result.stopReason = "aborted";
		result.status = wasAborted ? "aborted" : exitCode === 0 && result.stopReason !== "error" ? "done" : "failed";
		job.status = result.status;
		job.exitCode = exitCode;
		job.output = result.output;
		job.model = result.model;
		job.stopReason = result.stopReason;
		job.errorMessage = result.errorMessage;
		job.finishedAt = Date.now();
		job.updatedAt = job.finishedAt;
		job.abort = undefined;
		addJobLog(job, `${job.status} exit=${exitCode}`);
		return result;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function isFailure(result: RunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const resultDelivery = new ResultDelivery<RunResult>();
	let sessionContext: ExtensionContext | undefined;
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
	pi.on("session_start", (_event, ctx) => { sessionContext = ctx; });
	pi.on("agent_end", () => { flushResults(); });
	pi.on("session_shutdown", () => { sessionContext = undefined; resultDelivery.clear(); });

	const startBackground = async (params: SubagentParams, ctx: ExtensionContext, signal: AbortSignal | undefined) => {
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
		const job = createJob(params.agent, params.task, cwdResult.cwd, params.name);
		if (cwdResult.error) throw new Error(cwdResult.error);
		const agent = agents.find((candidate) => candidate.name === params.agent);
		if (!agent) throw new Error(`Unknown agent. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
		job.completion = runAgent(ctx.cwd, agent, job, cwdResult.cwd, params.model, signal);
		job.completion.then((result) => {
			resultDelivery.defer(result);
			if (sessionContext?.isIdle()) flushResults();
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

	pi.registerCommand("subagent-status", {
		description: "Show recent subagent job status",
		handler: async (_args, ctx) => {
			await ctx.ui.editor("Subagent jobs", formatStatusBlock());
		},
	});

	pi.registerCommand("subagent-log", {
		description: "Show a subagent job log: /subagent-log <job-id-or-name>",
		getArgumentCompletions: (prefix) =>
			[...jobs.values()]
				.filter((job) => job.id.startsWith(prefix) || job.name.startsWith(prefix))
				.slice(0, 10)
				.map((job) => ({ value: job.id, label: `${job.id} ${job.name} (${job.status})` })),
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /subagent-log <job-id-or-name>", "warning");
				return;
			}
			const job = findJob(query);
			if (!job) {
				ctx.ui.notify(`Unknown subagent job: ${query}`, "warning");
				return;
			}
			const body = [
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
			await ctx.ui.editor(`Subagent log: ${job.id}`, body);
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const active = [...jobs.values()].filter((job) => job.status === "initializing" || job.status === "working").length;
			if (active >= MAX_PARALLEL_TASKS) throw new Error(`Too many running subagents. Max is ${MAX_PARALLEL_TASKS}.`);
			const job = await startBackground(params, ctx, signal);
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
			return { content: [{ type: "text", text: formatStatusBlock() }], details: { jobs: [...jobs.values()] } };
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagents",
		description: "Wait for specified background subagents and return their final reports.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, description: "Subagent job ids" }) }),
		async execute(_toolCallId, params, signal, onUpdate) {
			resultDelivery.consume(params.ids);
			const selected = params.ids.map((id) => {
				const job = jobs.get(id);
				if (!job?.completion) throw new Error(`Unknown subagent job: ${id}`);
				return job;
			});
			if (signal?.aborted) throw new Error("Wait aborted. Subagents keep running.");
			onUpdate?.({ content: [{ type: "text", text: `Waiting for ${params.ids.join(", ")}...` }], details: { ids: params.ids } });
			const results = await Promise.all(selected.map((job) => job.completion!));
			return { content: [{ type: "text", text: results.map((result) => `## ${result.id} ${result.name} — ${result.status}\n\n${result.output}`).join("\n\n---\n\n") }], details: { results }, isError: results.some(isFailure) };
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
		async execute(_toolCallId, params: SubagentParams, signal, onUpdate, ctx) {
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
				const job = createJob(item.agent, item.task, cwdResult.cwd, item.name);
				if (cwdResult.error) {
					job.status = "failed";
					job.output = cwdResult.error;
					job.exitCode = 1;
					job.finishedAt = Date.now();
					addJobLog(job, cwdResult.error);
					return {
						id: job.id,
						name: job.name,
						agent: item.agent,
						task: item.task,
						status: "failed",
						exitCode: 1,
						output: cwdResult.error,
						stderr: "",
						messages: [],
					} satisfies RunResult;
				}
				const agent = agents.find((candidate) => candidate.name === item.agent);
				if (!agent) {
					const output = `Unknown agent. Available: ${agents.map((a) => a.name).join(", ") || "none"}`;
					job.status = "failed";
					job.output = output;
					job.exitCode = 1;
					job.finishedAt = Date.now();
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
				return runAgent(ctx.cwd, agent, job, cwdResult.cwd, item.model ?? params.model, signal);
			};

			if (hasSingle) {
				onUpdate?.({
					content: [{ type: "text", text: `Starting ${params.name ?? params.agent}...` }],
					details: { mode: "single", jobs: formatStatusBlock() },
				});
				const result = await run({ agent: params.agent!, task: params.task!, cwd: params.cwd, name: params.name, model: params.model });
				return {
					content: [{ type: "text", text: `Subagent ${result.id} (${result.name}) ${result.status}\n\n${result.output}` }],
					details: { mode: "single", result, job: jobs.get(result.id) },
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
				details: { mode: "parallel", results, jobs: results.map((result) => jobs.get(result.id)) },
				isError: succeeded !== results.length,
			};
		},
	});
}
