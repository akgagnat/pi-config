import assert from "node:assert/strict";
import test from "node:test";

import { CompletionBatcher } from "../extensions/subagents/completion-batcher.ts";
import { ResultDelivery } from "../extensions/subagents/result-delivery.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("successful completions share one deterministic grouping window", async () => {
	const groups: string[][] = [];
	const batcher = new CompletionBatcher(10, (ids) => groups.push(ids));
	batcher.success("sa-1");
	batcher.success("sa-2");
	assert.deepEqual(groups, []);
	await sleep(20);
	assert.deepEqual(groups, [["sa-1", "sa-2"]]);
	batcher.clear();
});

test("failures notify immediately without flushing pending successes", async () => {
	const groups: string[][] = [];
	const batcher = new CompletionBatcher(10, (ids) => groups.push(ids));
	batcher.success("success");
	batcher.failure("failed");
	assert.deepEqual(groups, [["failed"]]);
	await sleep(20);
	assert.deepEqual(groups, [["failed"], ["success"]]);
	batcher.clear();
});

test("wait consumption wins before or during deferred completion", async () => {
	const delivery = new ResultDelivery<{ id: string }>();
	const delivered: string[] = [];
	const batcher = new CompletionBatcher(10, (ids) => delivered.push(...delivery.take(ids).map((result) => result.id)));

	batcher.consume(["before"]);
	delivery.consume(["before"]);
	delivery.defer({ id: "before" });
	batcher.success("before");

	delivery.defer({ id: "during" });
	batcher.success("during");
	batcher.consume(["during"]);
	delivery.consume(["during"]);
	await sleep(20);
	assert.deepEqual(delivered, []);
	batcher.clear();
});

test("an aborted wait releases its reservation back to deferred delivery", async () => {
	const delivery = new ResultDelivery<{ id: string }>();
	const delivered: string[] = [];
	const batcher = new CompletionBatcher(10, (ids) => delivered.push(...delivery.take(ids).map((result) => result.id)));
	batcher.reserve(["sa-1"]);
	delivery.defer({ id: "sa-1" });
	batcher.success("sa-1");
	await sleep(15);
	assert.deepEqual(delivered, []);
	batcher.release(["sa-1"]);
	await sleep(20);
	assert.deepEqual(delivered, ["sa-1"]);
	assert.throws(() => delivery.assertNotDelivered(["sa-1"]), /already queued/);
	batcher.clear();
});

test("clearing the batcher cancels pending notification timers", async () => {
	const groups: string[][] = [];
	const batcher = new CompletionBatcher(10, (ids) => groups.push(ids));
	batcher.success("sa-1");
	batcher.clear();
	await sleep(20);
	assert.deepEqual(groups, []);
});
