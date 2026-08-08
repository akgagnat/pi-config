import assert from "node:assert/strict";
import test from "node:test";

import { formatInspectorActivity, formatThinkingVisibility, getInspectorDetailLines, moveInspectorSelection } from "../extensions/subagents/inspector.ts";
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
	assert.match(getInspectorDetailLines(job, "Communication", false).join("\n"), /parent tool call: call-1/);
	const metadata = getInspectorDetailLines(job, "Metadata", false).join("\n");
	assert.match(metadata, /42k\/200k \(21\.0%\) · estimated/);
	assert.match(metadata, /50k tokens · \$0\.1250/);
});

test("activity formatter summarizes tool calls without dumping unbounded arguments", () => {
	const line = formatInspectorActivity({ type: "tool-start", id: "tool-1", name: "bash", args: { command: "x".repeat(200) }, at: 0 });
	assert.match(line!, /→ bash/);
	assert.ok(line!.length < 150);
});
