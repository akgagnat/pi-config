import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { fitInspectorRows, formatInspectorActivity, formatThinkingVisibility, getInspectorDetailLines, getInspectorProjectionSignature, moveInspectorSelection, openSubagentInspector } from "../extensions/subagents/inspector.ts";
import { JobStore } from "../extensions/subagents/job-store.ts";

function inspectedJob() {
	const store = new JobStore({ now: () => 1 });
	store.create({
		id: "sa-1",
		name: "review",
		agent: "worker",
		task: "Review authentication",
		cwd: "/work/project",
		parent: { sessionId: "parent-1", toolCallId: "call-1" },
		model: { source: "parent", requested: "anthropic/sonnet", provider: "anthropic", id: "sonnet", contextWindow: 200_000 },
		delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false },
	});
	store.appendTimeline("sa-1", { type: "thinking-delta", contentIndex: 0, delta: "secret reasoning", at: 2 });
	store.appendTimeline("sa-1", { type: "tool-start", id: "tool-1", name: "read", args: { path: "auth.ts" }, at: 3 });
	store.appendTimeline("sa-1", { type: "tool-end", id: "tool-1", name: "read", isError: false, at: 4 });
	store.appendTimeline("sa-1", { type: "text-delta", contentIndex: 1, delta: "Review complete", at: 5 });
	store.appendTimeline("sa-1", { type: "context", tokens: 42_000, contextWindow: 200_000, percent: 21, contextQuality: "estimated", at: 6 });
	store.appendTimeline("sa-1", { type: "session-stats", totalTokens: 50_000, cost: 0.125, at: 7 });
	store.appendTimeline("sa-1", { type: "steering", steeringId: "steer-0001", instruction: "Focus on race handling", outcome: "requested", at: 8 });
	store.appendTimeline("sa-1", { type: "steering", steeringId: "steer-0001", instruction: "Focus on race handling", outcome: "accepted", message: "queued; compliance is not guaranteed", at: 9 });
	return store.get("sa-1")!;
}

test("arrow navigation follows the same newest-first order shown by the inspector", () => {
	let now = 0;
	const store = new JobStore({ now: () => ++now });
	for (const id of ["oldest", "middle", "newest"]) {
		store.create({
			id,
			name: id,
			agent: "worker",
			task: id,
			cwd: "/work/project",
			parent: {},
			model: { source: "default" },
			delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false },
		});
	}
	const jobs = store.list().sort((a, b) => b.startedAt - a.startedAt);
	let selected: string | undefined = jobs[0].id;
	selected = moveInspectorSelection(jobs, selected, 1);
	assert.equal(selected, "middle");
	selected = moveInspectorSelection(jobs, selected, 1);
	assert.equal(selected, "oldest");
	selected = moveInspectorSelection(jobs, selected, -1);
	assert.equal(selected, "middle");
	selected = moveInspectorSelection(jobs, selected, -1);
	assert.equal(selected, "newest");
});

test("inspector hides thinking unless explicitly enabled", () => {
	const job = inspectedJob();
	const hidden = getInspectorDetailLines(job, "Conversation", false).join("\n");
	const shown = getInspectorDetailLines(job, "Conversation", true).join("\n");
	assert.doesNotMatch(hidden, /secret reasoning/);
	assert.match(shown, /╭─ Thinking/);
	assert.match(shown, /│ secret reasoning/);
	assert.match(shown, /╰─ end thinking/);
	assert.match(hidden, /read/);
	assert.match(hidden, /Review complete/);
	assert.equal(formatThinkingVisibility(false), "thinking: OFF");
	assert.equal(formatThinkingVisibility(true), "thinking: ON");
});

test("inspector distinguishes communication and context metadata", () => {
	const job = inspectedJob();
	const communication = getInspectorDetailLines(job, "Communication", false).join("\n");
	assert.match(communication, /parent tool call: call-1/);
	assert.match(communication, /steer-0001 accepted: Focus on race handling/);
	assert.match(communication, /compliance is not guaranteed/);
	const metadata = getInspectorDetailLines(job, "Metadata", false).join("\n");
	assert.match(metadata, /42k\/200k \(21\.0%\) · estimated/);
	assert.match(metadata, /50k tokens · \$0\.1250/);
});

test("inspector viewport keeps a fixed height as streaming content grows", () => {
	assert.deepEqual(fitInspectorRows(["one"], 3), ["one", "", ""]);
	assert.deepEqual(fitInspectorRows(["one", "two", "three"], 2), ["one", "two"]);
});

test("inspector overlay fully covers the underlying terminal viewport", async () => {
	let rendered: string[] = [];
	let options: unknown;
	const tui = { terminal: { rows: 30 }, requestRender() {} };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory: any, receivedOptions: unknown) => {
				options = receivedOptions;
				const component = await factory(tui, theme, {}, () => {});
				rendered = component.render(120);
				component.dispose?.();
			},
		},
	} as any;
	await openSubagentInspector(ctx, new JobStore());
	assert.deepEqual(options, {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
	});
	assert.equal(rendered.length, 30);
	assert.ok(rendered.every((line) => visibleWidth(line) === 120));
});

test("inspector redraw projection ignores updates hidden by the active view", () => {
	const store = new JobStore({ now: () => 1 });
	store.create({
		id: "sa-1",
		name: "review",
		agent: "worker",
		task: "Review authentication",
		cwd: "/work/project",
		parent: {},
		model: { source: "default" },
		delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false },
	});
	const activityBefore = getInspectorProjectionSignature(store, "sa-1", "Activity", false);
	const conversationBefore = getInspectorProjectionSignature(store, "sa-1", "Conversation", false);
	store.appendTimeline("sa-1", { type: "text-delta", contentIndex: 0, delta: "streaming", at: 2 });
	assert.equal(getInspectorProjectionSignature(store, "sa-1", "Activity", false), activityBefore);
	assert.notEqual(getInspectorProjectionSignature(store, "sa-1", "Conversation", false), conversationBefore);
});

test("activity formatter summarizes tool calls without dumping unbounded arguments", () => {
	const line = formatInspectorActivity({ type: "tool-start", id: "tool-1", name: "bash", args: { command: "x".repeat(200) }, at: 0 });
	assert.match(line!, /→ bash/);
	assert.ok(line!.length < 150);
});
