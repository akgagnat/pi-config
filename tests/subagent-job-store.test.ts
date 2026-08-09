import assert from "node:assert/strict";
import test from "node:test";

import { JobStore, type CreateJobInput, type JobStoreChange } from "../extensions/subagents/job-store.ts";

function jobInput(id: string): CreateJobInput {
	return {
		id,
		name: `Job ${id}`,
		agent: "worker",
		task: "Inspect the repository",
		cwd: "/work/project",
		parent: {
			sessionId: "parent-session",
			toolCallId: "call-123",
			entryId: "entry-456",
			turnIndex: 2,
		},
		model: {
			requested: "anthropic/claude-sonnet-4-5",
			source: "parent",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: 200_000,
			thinkingLevel: "high",
		},
		delivery: {
			mode: "background",
			method: "deferred-follow-up",
			consumedByWait: false,
		},
	};
}

test("job store snapshots are immutable, detached, and structured-cloneable", () => {
	const input = jobInput("sa-1");
	const store = new JobStore({ now: () => 10 });
	const created = store.create(input);
	(input.parent as { sessionId?: string }).sessionId = "changed-after-create";
	(input.model as { provider?: string }).provider = "changed-after-create";

	assert.deepEqual(structuredClone(created), created);
	assert.equal(Object.isFrozen(created), true);
	assert.equal(Object.isFrozen(created.parent), true);
	assert.equal(Object.isFrozen(created.timeline), true);
	assert.equal(created.parent.sessionId, "parent-session");
	assert.equal(created.model.provider, "anthropic");
	assert.throws(() => ((created.parent as { sessionId?: string }).sessionId = "mutated"), TypeError);
	assert.equal(store.get("sa-1")?.parent.sessionId, "parent-session");
});

test("subscription publishes snapshots and supports returned and explicit unsubscribe", () => {
	let now = 1;
	const store = new JobStore({ now: () => now++ });
	const firstChanges: JobStoreChange[] = [];
	const secondChanges: JobStoreChange[] = [];
	const first = (change: JobStoreChange) => firstChanges.push(change);
	const unsubscribe = store.subscribe(first);
	const second = (change: JobStoreChange) => secondChanges.push(change);
	store.subscribe(second);

	store.create(jobInput("sa-1"));
	store.appendTimeline("sa-1", { type: "turn-start", turn: 1, at: 2 });
	unsubscribe();
	store.update("sa-1", { status: "working" });
	store.unsubscribe(second);
	store.appendTimeline("sa-1", { type: "turn-end", turn: 1, at: 4 });

	assert.deepEqual(firstChanges.map((change) => change.type), ["created", "updated"]);
	assert.deepEqual(secondChanges.map((change) => change.type), ["created", "updated", "updated"]);
	assert.equal(Object.isFrozen(firstChanges[0]), true);
	assert.doesNotThrow(() => structuredClone(firstChanges));
});

test("timeline, stderr, and output retention stay within configured bounds", () => {
	const store = new JobStore({
		maxTimelineEvents: 2,
		maxStderrBytes: 5,
		maxOutputBytes: 4,
		now: () => 1,
	});
	store.create(jobInput("sa-1"));
	store.appendTimeline("sa-1", { type: "turn-start", turn: 1, at: 1 });
	store.appendTimeline("sa-1", { type: "turn-end", turn: 1, at: 2 });
	store.appendTimeline("sa-1", { type: "status", status: "working", at: 3 });
	store.appendStderr("sa-1", "abc");
	store.appendStderr("sa-1", "dé");
	const snapshot = store.setOutput("sa-1", "ééé");

	assert.deepEqual(snapshot.timeline.map((event) => event.type), ["turn-end", "status"]);
	assert.equal(snapshot.droppedTimelineEvents, 1);
	assert.deepEqual(snapshot.stderr, { text: "bcdé", totalBytes: 6, truncated: true });
	assert.deepEqual(snapshot.output, { text: "éé", totalBytes: 6, truncated: true });
	assert.deepEqual(snapshot.delivery, {
		mode: "background",
		method: "deferred-follow-up",
		consumedByWait: false,
		originalOutputBytes: 6,
		deliveredOutputBytes: 4,
		outputTruncated: true,
	});
});

test("per-run output limits and updated completed retention are enforced", () => {
	const store = new JobStore({ maxCompletedJobs: 3, now: () => 1 });
	store.create(jobInput("sa-1"));
	store.appendStderr("sa-1", "abcdef", 4);
	const snapshot = store.setOutput("sa-1", "abcdef", 4);
	assert.deepEqual(snapshot.stderr, { text: "cdef", totalBytes: 6, truncated: true });
	assert.deepEqual(snapshot.output, { text: "abcd", totalBytes: 6, truncated: true });
	store.update("sa-1", { status: "done" });
	store.setCompletedJobRetention(0);
	assert.equal(store.get("sa-1"), undefined);
});

test("streaming telemetry is coalesced and large payloads are bounded", () => {
	const store = new JobStore({ now: () => 1 });
	store.create(jobInput("sa-1"));
	store.appendTimeline("sa-1", { type: "text-delta", contentIndex: 0, delta: "a", at: 1 });
	store.appendTimeline("sa-1", { type: "text-delta", contentIndex: 0, delta: "b", at: 2 });
	store.appendTimeline("sa-1", { type: "tool-start", id: "tool", name: "bash", args: { command: "x".repeat(9_000) }, at: 3 });
	const snapshot = store.get("sa-1")!;
	assert.equal(snapshot.timeline.length, 2);
	assert.deepEqual(snapshot.timeline[0], { type: "text-delta", contentIndex: 0, delta: "ab", at: 2 });
	assert.equal(snapshot.timeline[1].type === "tool-start" ? snapshot.timeline[1].args : undefined, "[tool arguments omitted: over 8KB]");
});

test("completed-job eviction removes the oldest completion without evicting active jobs", () => {
	let now = 10;
	const store = new JobStore({ maxCompletedJobs: 2, now: () => now++ });
	const changes: JobStoreChange[] = [];
	store.subscribe((change) => changes.push(change));
	store.create(jobInput("active"));
	store.create(jobInput("done-1"));
	store.update("done-1", { status: "done", exitCode: 0 });
	store.create(jobInput("done-2"));
	store.update("done-2", { status: "failed", exitCode: 1 });
	store.create(jobInput("done-3"));
	store.update("done-3", { status: "aborted", stopReason: "aborted" });

	assert.equal(store.get("active")?.status, "initializing");
	assert.equal(store.get("done-1"), undefined);
	assert.deepEqual(store.list().map((job) => job.id), ["active", "done-2", "done-3"]);
	assert.deepEqual(
		changes.filter((change) => change.type === "evicted").map((change) => change.job.id),
		["done-1"],
	);
});

test("model and delivery updates remain clone-safe and terminal jobs cannot restart", () => {
	const store = new JobStore({ now: () => 25 });
	store.create(jobInput("sa-1"));
	const completed = store.update("sa-1", {
		status: "done",
		model: { source: "profile", requested: "openai/gpt-5", provider: "openai", id: "gpt-5" },
		delivery: { mode: "background", method: "subagent-wait", consumedByWait: true },
	});

	assert.equal(completed.finishedAt, 25);
	assert.equal(completed.model.source, "profile");
	assert.equal(completed.delivery.consumedByWait, true);
	assert.doesNotThrow(() => structuredClone(completed));
	assert.throws(() => store.update("sa-1", { status: "working" }), /cannot transition/);
});
