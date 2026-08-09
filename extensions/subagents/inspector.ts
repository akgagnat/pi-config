import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DeepReadonly, JobSnapshot, JobStore } from "./job-store.ts";
import type { TelemetryEvent } from "./telemetry.ts";

const VIEWS = ["Activity", "Conversation", "Communication", "Metadata"] as const;
export type InspectorView = (typeof VIEWS)[number];

function formatCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(startedAt: number, finishedAt = Date.now()): string {
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function eventTime(event: { readonly at: number }): string {
	return new Date(event.at).toISOString().slice(11, 19);
}

function safeText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g, "�");
}

function summarizeValue(value: unknown, limit = 100): string {
	const text = safeText(typeof value === "string" ? value : JSON.stringify(value));
	if (!text) return "";
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function appendThinkingBlock(lines: string[], title: string, thinking: string): void {
	lines.push(`╭─ ${title}`);
	for (const line of thinking.split("\n")) lines.push(`│ ${safeText(line)}`);
	lines.push("╰─ end thinking", "");
}

export function formatThinkingVisibility(showThinking: boolean): string {
	return `thinking: ${showThinking ? "ON" : "OFF"}`;
}

export function formatInspectorActivity(event: DeepReadonly<TelemetryEvent>): string | undefined {
	const prefix = eventTime(event);
	switch (event.type) {
		case "activity": return `${prefix}  ${event.message}`;
		case "status": return `${prefix}  status: ${event.status}${event.message ? ` — ${event.message}` : ""}`;
		case "turn-start": return `${prefix}  turn ${event.turn} started`;
		case "turn-end": return `${prefix}  turn ${event.turn} ended`;
		case "tool-start": return `${prefix}  → ${event.name} ${summarizeValue(event.args)}`;
		case "tool-end": return `${prefix}  ← ${event.name} ${event.isError ? "failed" : "completed"}`;
		case "retry": return `${prefix}  retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`;
		case "compaction": return `${prefix}  compaction ${event.phase} (${event.reason})`;
		case "context": return `${prefix}  context ${event.tokens === null ? "unknown" : formatCount(event.tokens)}/${formatCount(event.contextWindow)}${event.percent === null ? "" : ` (${event.percent.toFixed(1)}%)`}`;
		case "session-stats": return `${prefix}  usage ${formatCount(event.totalTokens)} tokens · $${event.cost.toFixed(4)}`;
		case "steering": return `${prefix}  steer ${event.steeringId} ${event.outcome}`;
		case "escalation": return `${prefix}  supervisor ${event.requestId} ${event.kind} ${event.status}`;
		case "agent-end": return `${prefix}  agent ended${event.stopReason ? ` (${event.stopReason})` : ""}`;
		default: return undefined;
	}
}

function latest<T extends TelemetryEvent["type"]>(job: JobSnapshot, type: T): DeepReadonly<Extract<TelemetryEvent, { type: T }>> | undefined {
	for (let index = job.timeline.length - 1; index >= 0; index--) {
		const event = job.timeline[index];
		if (event.type === type) return event as DeepReadonly<Extract<TelemetryEvent, { type: T }>>;
	}
	return undefined;
}

export function getInspectorDetailLines(job: JobSnapshot, view: InspectorView, showThinking: boolean): string[] {
	if (view === "Activity") {
		const lines = job.timeline.flatMap((event) => {
			const line = formatInspectorActivity(event);
			return line ? [line] : [];
		});
		if (job.droppedTimelineEvents) lines.unshift(`… ${job.droppedTimelineEvents} earlier events omitted`);
		return lines.length ? lines : ["(no activity yet)"];
	}
	if (view === "Conversation") {
		const lines: string[] = [];
		let text = "";
		let thinking = "";
		for (const event of job.timeline) {
			if (event.type === "text-delta") text += event.delta;
			if (event.type === "thinking-delta") thinking += event.delta;
			if (event.type === "assistant-message") {
				if (showThinking && event.thinking) appendThinkingBlock(lines, "Thinking", event.thinking);
				if (event.text) lines.push("Assistant:", event.text, "");
				text = "";
				thinking = "";
			}
			if (event.type === "tool-start") lines.push(`→ ${event.name} ${summarizeValue(event.args, 180)}`);
			if (event.type === "tool-end") lines.push(`← ${event.name} ${event.isError ? "failed" : "completed"}`);
		}
		if (showThinking && thinking) appendThinkingBlock(lines, "Thinking (streaming)", thinking);
		if (text) lines.push("Assistant (streaming):", text);
		else if (lines.length === 0) lines.push("(waiting for assistant output)");
		return lines;
	}
	if (view === "Communication") {
		const escalationLines = job.timeline
			.filter((event) => event.type === "escalation")
			.flatMap((event) => [
				`  ${eventTime(event)} ${event.requestId} ${event.kind} ${event.status}: ${safeText(event.subject)}`,
				`    ${safeText(event.message)}`,
				...(event.reply ? [`    reply: ${safeText(event.reply)}`] : []),
				...(event.error ? [`    error: ${safeText(event.error)}`] : []),
			]);
		const steeringLines = job.timeline
			.filter((event) => event.type === "steering")
			.flatMap((event) => [
				`  ${eventTime(event)} ${event.steeringId} ${event.outcome}: ${safeText(event.instruction)}`,
				...(event.message ? [`    ${safeText(event.message)}`] : []),
			]);
		return [
			"Parent → child",
			`  parent session: ${job.parent.sessionId ?? "unknown"}`,
			`  parent tool call: ${job.parent.toolCallId ?? "unknown"}`,
			`  delivery mode: ${job.delivery.mode}`,
			`  agent profile: ${job.agent}`,
			`  model source: ${job.model.source}`,
			`  task: ${safeText(job.task)}`,
			"",
			"Steering ledger",
			...(job.droppedSteeringEvents ? [`  … ${job.droppedSteeringEvents} earlier steering events omitted`] : []),
			...(steeringLines.length ? steeringLines : ["  (none)"]),
			"",
			"Escalation ledger",
			...(escalationLines.length ? escalationLines : ["  (none)"]),
			"",
			"Child → parent",
			`  method: ${job.delivery.method}`,
			`  consumed by wait: ${job.delivery.consumedByWait ? "yes" : "no"}`,
			`  original output: ${job.delivery.originalOutputBytes ?? 0} bytes`,
			`  delivered output: ${job.delivery.deliveredOutputBytes ?? 0} bytes`,
			`  truncated: ${job.delivery.outputTruncated ? "yes" : "no"}`,
		];
	}
	const context = latest(job, "context");
	const stats = latest(job, "session-stats");
	return [
		`id: ${job.id}`,
		`name: ${safeText(job.name)}`,
		`status: ${job.status}`,
		`agent: ${job.agent}`,
		`cwd: ${job.cwd}`,
		`duration: ${formatDuration(job.startedAt, job.finishedAt)}`,
		`model: ${job.model.provider && job.model.id ? `${job.model.provider}/${job.model.id}` : job.model.requested ?? "Pi default"}`,
		`model source: ${job.model.source}`,
		`thinking: ${job.model.thinkingLevel ?? "unknown"}`,
		`context: ${context ? `${context.tokens === null ? "unknown" : formatCount(context.tokens)}/${formatCount(context.contextWindow)}${context.percent === null ? "" : ` (${context.percent.toFixed(1)}%)`} · ${context.contextQuality}` : "unknown"}`,
		`cumulative usage: ${stats ? `${formatCount(stats.totalTokens)} tokens · $${stats.cost.toFixed(4)}` : "unknown"}`,
		`exit: ${job.exitCode ?? "—"}`,
		`stop reason: ${job.stopReason ?? "—"}`,
		`error: ${job.errorMessage ?? "—"}`,
		`stderr retained: ${job.stderr.text.length ? `${Buffer.byteLength(job.stderr.text, "utf8")}/${job.stderr.totalBytes} bytes` : "none"}`,
	];
}

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function sortedInspectorJobs(store: JobStore): DeepReadonly<JobSnapshot>[] {
	return store.list().sort((a, b) => b.startedAt - a.startedAt);
}

export function moveInspectorSelection(jobs: readonly DeepReadonly<JobSnapshot>[], selectedId: string | undefined, delta: -1 | 1): string | undefined {
	if (jobs.length === 0) return undefined;
	const current = Math.max(0, jobs.findIndex((job) => job.id === selectedId));
	return jobs[Math.max(0, Math.min(jobs.length - 1, current + delta))].id;
}

export async function openSubagentInspector(ctx: ExtensionContext, store: JobStore): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let selectedId: string | undefined;
		let lastWide = false;
		let viewIndex = 0;
		let scroll = 0;
		let follow = true;
		let showThinking = false;
		let narrowDetail = false;
		let renderTimer: NodeJS.Timeout | undefined;
		const requestRender = () => {
			if (renderTimer) return;
			renderTimer = setTimeout(() => {
				renderTimer = undefined;
				tui.requestRender();
			}, 100);
		};
		const unsubscribe = store.subscribe(requestRender);
		const component = {
			render(width: number): string[] {
				const jobs = sortedInspectorJobs(store);
				let selected = Math.max(0, jobs.findIndex((candidate) => candidate.id === selectedId));
				const job = jobs[selected];
				selectedId = job?.id;
				const height = Math.max(8, tui.terminal.rows - 4);
				const wide = width >= 100;
				lastWide = wide;
				const tabs = VIEWS.map((name, index) => index === viewIndex ? theme.fg("accent", `[${name}]`) : theme.fg("muted", name)).join("  ");
				const header = theme.fg("accent", theme.bold("Subagent inspector"));
				const thinkingVisibility = theme.fg(showThinking ? "warning" : "dim", formatThinkingVisibility(showThinking));
				const help = `${theme.fg("dim", "↑↓ select · j/k scroll · enter inspect · tab view · f follow · t toggle")} · ${thinkingVisibility} · ${theme.fg("dim", "esc close")}`;
				if (!job) return [header, "", theme.fg("muted", "No subagent jobs yet."), "", help].map((line) => truncateToWidth(line, width));
				const context = latest(job, "context");
				const summary = `${job.id} ${job.status} · ${safeText(job.agent)} · ${safeText(job.model.provider && job.model.id ? `${job.model.provider}/${job.model.id}` : job.model.requested ?? "default")} · ctx ${context?.tokens === null || !context ? "?" : formatCount(context.tokens)}/${context ? formatCount(context.contextWindow) : "?"}`;
				const details = getInspectorDetailLines(job, VIEWS[viewIndex], showThinking).flatMap((line) => wrapTextWithAnsi(line, wide ? width - 38 : width));
				const bodyHeight = Math.max(3, height - 5);
				if (follow) scroll = Math.max(0, details.length - bodyHeight);
				else scroll = Math.min(scroll, Math.max(0, details.length - bodyHeight));
				const visibleDetails = details.slice(scroll, scroll + bodyHeight);
				if (!wide && !narrowDetail) {
					const listStart = Math.max(0, Math.min(selected - bodyHeight + 1, jobs.length - bodyHeight));
					const list = jobs.slice(listStart, listStart + bodyHeight).map((item, offset) => {
						const index = listStart + offset;
						const marker = index === selected ? theme.fg("accent", "> ") : "  ";
						return truncateToWidth(`${marker}${item.id} ${item.status} ${safeText(item.name)}`, width);
					});
					return [header, theme.fg("muted", summary), "", ...list, "", help].map((line) => truncateToWidth(line, width));
				}
				if (!wide) return [header, theme.fg("muted", summary), tabs, "", ...visibleDetails, "", help].map((line) => truncateToWidth(line, width));
				const listWidth = 34;
				const listStart = Math.max(0, Math.min(selected - bodyHeight + 1, jobs.length - bodyHeight));
				const list = jobs.slice(listStart, listStart + bodyHeight).map((item, offset) => {
					const index = listStart + offset;
					const marker = index === selected ? theme.fg("accent", "> ") : "  ";
					return `${marker}${item.id} ${item.status} ${safeText(item.name)}`;
				});
				const rows = Array.from({ length: Math.max(list.length, visibleDetails.length, 1) }, (_, index) => `${padToWidth(list[index] ?? "", listWidth)} │ ${truncateToWidth(visibleDetails[index] ?? "", width - listWidth - 3)}`);
				return [header, theme.fg("muted", summary), tabs, "", ...rows, "", help].map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string): void {
				const jobs = sortedInspectorJobs(store);
				if (matchesKey(data, Key.escape)) {
					if (narrowDetail) { narrowDetail = false; scroll = 0; }
					else done();
				} else if (matchesKey(data, Key.enter)) {
					if (!lastWide) narrowDetail = true;
				} else if (matchesKey(data, Key.tab)) {
					viewIndex = (viewIndex + 1) % VIEWS.length;
					scroll = 0;
				} else if (data === "f") {
					follow = !follow;
				} else if (data === "t") {
					showThinking = !showThinking;
				} else if (data === "k" || (narrowDetail && matchesKey(data, Key.up))) {
					follow = false;
					scroll = Math.max(0, scroll - 1);
				} else if (data === "j" || (narrowDetail && matchesKey(data, Key.down))) {
					follow = false;
					scroll++;
				} else if (matchesKey(data, Key.up)) {
					selectedId = moveInspectorSelection(jobs, selectedId, -1);
					scroll = 0;
				} else if (matchesKey(data, Key.down)) {
					selectedId = moveInspectorSelection(jobs, selectedId, 1);
					scroll = 0;
				}
				tui.requestRender();
			},
			invalidate(): void {},
			dispose(): void {
				unsubscribe();
				if (renderTimer) clearTimeout(renderTimer);
			},
		};
		return component;
	});
}
