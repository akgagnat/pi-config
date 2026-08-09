import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { RpcProcessClient } from "../extensions/subagents/rpc.ts";

type FakeChild = ChildProcessWithoutNullStreams & {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killSignals: string[];
};

function fakeChild(): FakeChild {
	const process = new EventEmitter() as unknown as FakeChild;
	process.stdin = new PassThrough();
	process.stdout = new PassThrough();
	process.stderr = new PassThrough();
	process.killSignals = [];
	process.kill = (signal = "SIGTERM") => {
		process.killSignals.push(String(signal));
		return true;
	};
	return process;
}

async function nextWrittenJson(stream: PassThrough): Promise<any> {
	return new Promise((resolve) => stream.once("data", (data) => resolve(JSON.parse(data.toString()))));
}

test("RPC client correlates responses without emitting them as events", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	const events: string[] = [];
	client.onEvent((event) => events.push(event.type));
	const written = nextWrittenJson(child.stdin);
	const statePromise = client.getState();
	const request = await written;
	assert.equal(request.type, "get_state");
	child.stdout.write(`${JSON.stringify({
		type: "response",
		id: request.id,
		command: "get_state",
		success: true,
		data: { thinkingLevel: "off", isStreaming: false },
	})}\n`);
	assert.equal((await statePromise).thinkingLevel, "off");
	assert.deepEqual(events, []);
	client.dispose();
});

test("RPC client reports steering acceptance and RPC rejection", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	let written = nextWrittenJson(child.stdin);
	const accepted = client.steer("Focus on tests");
	let request = await written;
	assert.equal(request.type, "steer");
	child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "steer", success: true })}\n`);
	await accepted;

	written = nextWrittenJson(child.stdin);
	const prompted = client.prompt("Focus on the race", "steer");
	request = await written;
	assert.equal(request.type, "prompt");
	assert.equal(request.streamingBehavior, "steer");
	child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true })}\n`);
	await prompted;

	written = nextWrittenJson(child.stdin);
	const rejected = client.steer("Stop editing");
	request = await written;
	child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "steer", success: false, error: "not streaming" })}\n`);
	await assert.rejects(rejected, /not streaming/);
	client.dispose();
});

test("RPC client emits fragmented LF-delimited events", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	const events: string[] = [];
	client.onEvent((event) => events.push(event.type));
	child.stdout.write('{"type":"turn_');
	child.stdout.write('start"}\n{"type":"agent_settled"}\n');
	assert.deepEqual(events, ["turn_start", "agent_settled"]);
	client.dispose();
});

test("RPC client automatically cancels child extension dialogs", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	const written = nextWrittenJson(child.stdin);
	child.stdout.write('{"type":"extension_ui_request","id":"ui-1","method":"confirm"}\n');
	assert.deepEqual(await written, { type: "extension_ui_response", id: "ui-1", cancelled: true });
	client.dispose();
});

test("RPC client does not respond to fire-and-forget extension UI", () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	let writes = 0;
	child.stdin.on("data", () => writes++);
	child.stdout.write('{"type":"extension_ui_request","id":"ui-1","method":"notify"}\n');
	assert.equal(writes, 0);
	client.dispose();
});

test("RPC client treats malformed protocol records as fatal", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	const request = client.getState();
	child.stdout.write("not-json\n");
	await assert.rejects(request, /Invalid JSON/);
	assert.deepEqual(child.killSignals, ["SIGTERM"]);
	client.dispose();
});

test("RPC client terminates an oversized unterminated frame", () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child, { maxFrameBytes: 8 });
	child.stdout.write("123456789");
	assert.deepEqual(child.killSignals, ["SIGTERM"]);
	client.dispose();
});

test("RPC client rejects pending requests when the process closes", async () => {
	const child = fakeChild();
	const client = new RpcProcessClient(child);
	const request = client.getSessionStats();
	child.emit("close", 1, null);
	await assert.rejects(request, /closed \(code=1/);
	client.dispose();
});
