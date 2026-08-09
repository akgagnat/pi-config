import assert from "node:assert/strict";
import test from "node:test";

import { encodeContactEnvelope } from "../extensions/subagents/contact-protocol.ts";
import { EscalationIngress, EscalationRegistry } from "../extensions/subagents/escalation.ts";
import { JobStore } from "../extensions/subagents/job-store.ts";

function makeStore(): JobStore {
	const store = new JobStore();
	store.create({ id: "sa-1", name: "worker", agent: "worker", task: "work", cwd: "/work", parent: { sessionId: "session-1" }, model: { source: "default" }, delivery: { mode: "background", method: "deferred-follow-up", consumedByWait: false } });
	store.update("sa-1", { status: "working" });
	return store;
}

function envelope(id: string, kind: "decision" | "input" | "progress" = "decision"): string {
	return encodeContactEnvelope({ version: 1, requestId: id, kind, subject: "Need a decision", message: "Choose A or B" });
}

const FIRST_ID = "11111111-1111-4111-8111-111111111111";

test("reserved requests race safely between prompt start and channel registration", () => {
	const store = makeStore();
	const registry = new EscalationRegistry(store);
	const ingress = new EscalationIngress(registry, "sa-1");
	const request = { id: "ui-fast", method: "input", title: "pi-subagent-contact-v1", placeholder: envelope(FIRST_ID) };
	assert.equal(ingress.handle(request), false);
	ingress.beginPrompt();
	assert.equal(ingress.handle(request), true);
	registry.register("sa-1", { sessionId: "session-1", respond() {} });
	ingress.flush(() => assert.fail("buffered reserved request should be accepted"));
	assert.equal(registry.list("session-1")[0].status, "pending");
	registry.clear("test cleanup");
});

test("blocking escalation is session-scoped, correlated, and replied exactly once", () => {
	const store = makeStore();
	const registry = new EscalationRegistry(store);
	const responses: unknown[] = [];
	registry.register("sa-1", { sessionId: "session-1", respond: (id, response) => responses.push({ id, response }) });
	assert.equal(registry.receive("sa-1", { id: "ui-1", method: "input", title: "pi-subagent-contact-v1", placeholder: envelope(FIRST_ID) }), true);
	assert.equal(registry.list("other-session").length, 0);
	assert.equal(registry.list("session-1")[0].status, "pending");
	const replied = registry.reply("session-1", FIRST_ID, "Choose A");
	assert.equal(replied.status, "replied");
	assert.deepEqual(responses, [{ id: "ui-1", response: { value: "Choose A" } }]);
	assert.throws(() => registry.reply("session-1", FIRST_ID, "again"), /already replied/);
	assert.throws(() => registry.reply("other-session", FIRST_ID, "guess"), /Unknown supervisor request/);
	const events = store.get("sa-1")!.timeline.filter((event) => event.type === "escalation");
	assert.deepEqual(events.map((event) => event.status), ["pending", "replied"]);
});

test("progress is non-blocking and unrelated UI requests are not claimed", () => {
	const registry = new EscalationRegistry(makeStore());
	const responses: unknown[] = [];
	registry.register("sa-1", { sessionId: "session-1", respond: (_id, response) => responses.push(response) });
	assert.equal(registry.receive("sa-1", { id: "notice", method: "notify", message: envelope(FIRST_ID, "progress") }), true);
	assert.equal(registry.list("session-1")[0].status, "progress");
	assert.deepEqual(responses, []);
	assert.equal(registry.receive("sa-1", { id: "ordinary", method: "input", title: "pi-subagent-contact-v1", placeholder: "not reserved" }), false);
});

test("timeout and parent shutdown cancel pending requests", async () => {
	const responses: unknown[] = [];
	const registry = new EscalationRegistry(makeStore(), { timeoutMs: 5 });
	registry.register("sa-1", { sessionId: "session-1", respond: (id, response) => responses.push({ id, response }) });
	registry.receive("sa-1", { id: "ui-timeout", method: "input", title: "pi-subagent-contact-v1", placeholder: envelope(FIRST_ID) });
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(registry.list("session-1")[0].status, "timed-out");
	assert.deepEqual(responses, [{ id: "ui-timeout", response: { cancelled: true } }]);

	const second = "22222222-2222-4222-8222-222222222222";
	registry.receive("sa-1", { id: "ui-shutdown", method: "input", title: "pi-subagent-contact-v1", placeholder: envelope(second, "input") });
	registry.clear("parent session shut down");
	assert.deepEqual(registry.list("session-1"), []);
	assert.deepEqual(responses.at(-1), { id: "ui-shutdown", response: { cancelled: true } });
});

test("request and reply envelopes enforce UTF-8 byte bounds", () => {
	assert.throws(() => encodeContactEnvelope({ version: 1, requestId: FIRST_ID, kind: "input", subject: "x", message: "é".repeat(10_000) }), /20,000 UTF-8 bytes/);
	const registry = new EscalationRegistry(makeStore());
	registry.register("sa-1", { sessionId: "session-1", respond() {} });
	registry.receive("sa-1", { id: "ui-1", method: "input", title: "pi-subagent-contact-v1", placeholder: envelope(FIRST_ID) });
	assert.throws(() => registry.reply("session-1", FIRST_ID, "é".repeat(10_001)), /20,000 UTF-8 bytes/);
});
