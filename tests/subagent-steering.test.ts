import assert from "node:assert/strict";
import test from "node:test";

import { JobStore, type CreateJobInput } from "../extensions/subagents/job-store.ts";
import { SteeringRegistry } from "../extensions/subagents/steering.ts";

function createWorkingJob(store: JobStore, id = "sa-1"): void {
	const input: CreateJobInput = {
		id,
		name: "worker",
		agent: "worker",
		task: "Inspect the repository",
		cwd: "/work/project",
		parent: {},
		model: { source: "default" },
		delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false },
	};
	store.create(input);
	store.update(id, { status: "working" });
}

test("working child records requested and accepted steering delivery", async () => {
	const store = new JobStore();
	createWorkingJob(store);
	const steering = new SteeringRegistry(store);
	const received: string[] = [];
	steering.register("sa-1", async (instruction) => { received.push(instruction); });

	const result = await steering.deliver("sa-1", "  Focus on race tests.  ");
	assert.equal(result.jobId, "sa-1");
	assert.equal(result.outcome, "accepted");
	assert.match(result.message, /compliance is not guaranteed/);
	assert.deepEqual(received, ["Focus on race tests."]);
	assert.deepEqual(
		store.get("sa-1")!.timeline.filter((event) => event.type === "steering").map((event) => event.outcome),
		["requested", "accepted"],
	);
});

test("completed and unavailable children reject steering with useful outcomes", async () => {
	const store = new JobStore();
	createWorkingJob(store);
	const steering = new SteeringRegistry(store);
	steering.register("sa-1", async () => {});
	store.update("sa-1", { status: "done" });
	await assert.rejects(steering.deliver("sa-1", "Continue"), /job is done/);
	await assert.rejects(steering.deliver("missing", "Continue"), /Unknown subagent job/);
	const lastEvent = store.get("sa-1")!.timeline.at(-1);
	assert.equal(lastEvent?.type, "steering");
	assert.equal(lastEvent?.type === "steering" ? lastEvent.outcome : undefined, "unavailable");
});

test("RPC rejection and process-exit errors become failed delivery", async () => {
	for (const message of ["RPC rejected instruction", "Subagent RPC process closed (code=1, signal=none)."] ) {
		const store = new JobStore();
		createWorkingJob(store);
		const steering = new SteeringRegistry(store);
		steering.register("sa-1", async () => { throw new Error(message); });
		await assert.rejects(steering.deliver("sa-1", "Continue"), new RegExp(message.replace(/[().]/g, "\\$&")));
		const events = store.get("sa-1")!.timeline.filter((event) => event.type === "steering");
		assert.equal(events.at(-1)?.outcome, "failed");
	}
});

test("settlement observed during an in-flight steer waits for post-acceptance settlement", async () => {
	const store = new JobStore();
	createWorkingJob(store);
	const steering = new SteeringRegistry(store);
	let accept!: () => void;
	steering.register("sa-1", () => new Promise<void>((resolve) => { accept = resolve; }));
	const inFlight = steering.deliver("sa-1", "Continue with tests");
	assert.equal(steering.observeSettled("sa-1"), false);
	let finalized = false;
	const settlement = steering.waitForFinalSettlement("sa-1", 1_000).then(() => { finalized = true; });
	accept();
	await inFlight;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finalized, false);
	assert.equal(steering.observeSettled("sa-1"), true);
	await settlement;
	assert.equal(finalized, true);
});

test("cancellation race never reopens a terminating channel", async () => {
	const store = new JobStore();
	createWorkingJob(store);
	const steering = new SteeringRegistry(store);
	let accept!: () => void;
	steering.register("sa-1", () => new Promise<void>((resolve) => { accept = resolve; }));
	const inFlight = steering.deliver("sa-1", "First instruction");
	steering.markUnavailable("sa-1", "cancellation is in progress");
	accept();
	assert.equal((await inFlight).outcome, "accepted");
	await assert.rejects(steering.deliver("sa-1", "Second instruction"), /cancellation is in progress/);
});

test("runtime byte limit rejects multibyte instructions that exceed the documented bound", async () => {
	const store = new JobStore();
	createWorkingJob(store);
	const steering = new SteeringRegistry(store);
	steering.register("sa-1", async () => {});
	await assert.rejects(steering.deliver("sa-1", "é".repeat(10_001)), /20,000 UTF-8 bytes/);
});

test("steering ledger evicts oldest steering records independently", async () => {
	const store = new JobStore({ maxSteeringEvents: 3 });
	createWorkingJob(store);
	store.appendTimeline("sa-1", { type: "activity", message: "keep me", at: 1 });
	const steering = new SteeringRegistry(store);
	steering.register("sa-1", async () => {});
	await steering.deliver("sa-1", "one");
	await steering.deliver("sa-1", "two");
	const snapshot = store.get("sa-1")!;
	assert.equal(snapshot.timeline.filter((event) => event.type === "steering").length, 3);
	assert.equal(snapshot.droppedSteeringEvents, 1);
	assert.equal(snapshot.timeline.some((event) => event.type === "activity" && event.message === "keep me"), true);
});
