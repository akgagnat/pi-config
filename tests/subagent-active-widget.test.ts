import assert from "node:assert/strict";
import test from "node:test";

import { ActiveJobWidget, formatActiveJobWidget } from "../extensions/subagents/active-widget.ts";
import { JobStore } from "../extensions/subagents/job-store.ts";

function addJob(store: JobStore): void {
	store.create({ id: "sa-1", name: "research", agent: "worker", task: "work", cwd: "/work", parent: {}, model: { source: "default" }, delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false }, startedAt: 1_000 });
}

test("active widget shows elapsed activity and inspector path, then clears with no active jobs", () => {
	const store = new JobStore({ now: () => 1_000 });
	assert.deepEqual(formatActiveJobWidget(store, 3_000), []);
	addJob(store);
	store.update("sa-1", { status: "working" });
	store.appendTimeline("sa-1", { type: "activity", message: "reading files", at: 2_000 });
	const lines = formatActiveJobWidget(store, 3_000);
	assert.match(lines.join("\n"), /sa-1 research · 2s · reading files/);
	assert.match(lines.at(-1)!, /\/subagents opens the read-only inspector/);
	store.update("sa-1", { status: "done" });
	assert.deepEqual(formatActiveJobWidget(store, 4_000), []);
});

test("widget lifecycle is TUI-only and shutdown clears widget state", () => {
	const store = new JobStore();
	const calls: Array<{ key: string; value: unknown }> = [];
	const makeCtx = (mode: string) => ({ mode, sessionManager: { getSessionId: () => undefined }, ui: { setWidget(key: string, value: unknown) { calls.push({ key, value }); } } }) as any;
	const widget = new ActiveJobWidget(store, 10);
	widget.start(makeCtx("rpc"));
	addJob(store);
	assert.deepEqual(calls, []);
	widget.start(makeCtx("tui"));
	const lastValue = () => (calls[calls.length - 1] as { key: string; value: unknown } | undefined)?.value;
	assert.ok(Array.isArray(lastValue()));
	store.update("sa-1", { status: "done" });
	assert.equal(lastValue(), undefined);
	widget.stop();
	assert.equal(lastValue(), undefined);
});
