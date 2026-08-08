import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatActivityStatus } from "../extensions/subagents/status.ts";
import { isTrustedChildCwd } from "../extensions/subagents/policy.ts";
import { truncateOutput } from "../extensions/subagents/output.ts";
import { ResultDelivery } from "../extensions/subagents/result-delivery.ts";
import { JobManager, toJobSnapshot } from "../extensions/subagents/jobs.ts";
import subagentsExtension from "../extensions/subagents/index.ts";
import { discoverAgents, parseFrontmatter } from "../extensions/subagents/profiles.ts";

test("activity status distinguishes active and failed subagents", () => {
	assert.equal(formatActivityStatus({ running: 2, done: 1, failed: 0 }), "subagents: 2 running · 1 done");
	assert.equal(formatActivityStatus({ running: 0, done: 0, failed: 1 }), "subagents: 1 failed");
});

test("child cwd policy keeps profile agents inside the trusted parent project", () => {
	assert.equal(isTrustedChildCwd("/work/project", "/work/project"), true);
	assert.equal(isTrustedChildCwd("/work/project", "/work/project/packages/app"), true);
	assert.equal(isTrustedChildCwd("/work/project", "/work/other"), false);
});

test("output truncation respects UTF-8 byte and line limits", () => {
	assert.deepEqual(truncateOutput("one\ntwo\nthree", { maxBytes: 100, maxLines: 2 }), {
		text: "one\ntwo\n\n[Output truncated: 2 of 3 lines shown.]",
		truncated: true,
	});
	assert.equal(truncateOutput("ééé", { maxBytes: 4, maxLines: 10 }).text, "éé\n\n[Output truncated: 4 of 6 bytes shown.]");
});

test("result delivery defers completed jobs and lets an explicit wait consume them", () => {
	const delivery = new ResultDelivery<{ id: string }>();
	delivery.defer({ id: "sa-1" });
	delivery.consume(["sa-1"]);
	assert.deepEqual(delivery.drain(), []);
	delivery.consume(["sa-2"]);
	delivery.defer({ id: "sa-2" });
	assert.deepEqual(delivery.drain(), []);
	delivery.defer({ id: "sa-3" });
	assert.deepEqual(delivery.drain(), [{ id: "sa-3" }]);
});

test("subagent job details remain structured-cloneable while work is running", () => {
	const details = toJobSnapshot({
		id: "sa-1",
		name: "research",
		agent: "worker",
		status: "working",
		cwd: "/work/project",
		startedAt: 1,
		updatedAt: 2,
		completion: Promise.resolve("report"),
		abort: () => {},
	} as any);
	assert.deepEqual(structuredClone(details), details);
	assert.deepEqual(Object.keys(details).sort(), ["agent", "cwd", "id", "name", "startedAt", "status", "updatedAt"]);
});

test("an unavailable profile does not leave an initializing background job", async () => {
	const tools = new Map<string, any>();
	subagentsExtension({
		on() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		sendMessage() {},
	} as any);
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => false,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { setStatus() {} },
	};
	await assert.rejects(
		tools.get("subagent_spawn").execute("call", { agent: "general", task: "do work" }, undefined, undefined, ctx),
		/Unknown agent/,
	);
	const listing = await tools.get("subagent_list").execute();
	assert.match(listing.content[0].text, /No subagent jobs yet/);
	assert.doesNotThrow(() => structuredClone(listing.details));
});

test("subagents opens the read-only live inspector", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	subagentsExtension({
		on() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		sendMessage() {},
	} as any);
	const baseCtx = {
		cwd: process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => false,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { setStatus() {} },
	};
	const result = await tools.get("subagent").execute(
		"call",
		{ agent: "missing", task: "do work" },
		undefined,
		undefined,
		baseCtx,
	);
	const id = result.details.result.id;
	let customCalls = 0;
	await commands.get("subagents").handler("", {
		...baseCtx,
		mode: "tui",
		ui: {
			...baseCtx.ui,
			notify() {},
			custom: async () => { customCalls++; },
		},
	});
	assert.equal(commands.has("subagent-profiles"), true);
	assert.equal(commands.has("subagents-status"), false);
	assert.equal(commands.has("subagent-log"), false);
	assert.equal(customCalls, 1);
	assert.match(id, /^sa-/);
});

test("job manager lets callers inspect work before collecting its result", async () => {
	let finish!: (value: string) => void;
	const manager = new JobManager<string>(1, () => "sa-1");
	const job = manager.start("research", () => new Promise((resolve) => { finish = resolve; }));
	assert.deepEqual(manager.list().map(({ id, name, status }) => ({ id, name, status })), [{ id: "sa-1", name: "research", status: "initializing" }]);
	assert.throws(() => manager.start("second", async () => "nope"), /Too many running subagents/);
	finish("report");
	assert.deepEqual(await manager.wait([job.id]), ["report"]);
	assert.deepEqual(manager.get(job.id), { id: "sa-1", name: "research", status: "done", result: "report" });
});

test("profile parsing keeps the Markdown body and profile metadata", () => {
	assert.deepEqual(
		parseFrontmatter("---\nname: reviewer\ndescription: Reviews changes\ntools: read, grep\n---\n\nReview carefully."),
		{
			frontmatter: { name: "reviewer", description: "Reviews changes", tools: "read, grep" },
			body: "Review carefully.",
		},
	);
});

test("profile discovery gives project profiles precedence in all scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-profiles-"));
	try {
		const configDir = join(root, "config");
		const userDir = join(root, "user");
		const projectDir = join(root, ".pi", "agents");
		await Promise.all([mkdir(configDir, { recursive: true }), mkdir(userDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);
		await Promise.all([
			writeFile(join(configDir, "reviewer.md"), "---\nname: reviewer\ndescription: Config reviewer\n---\nconfig"),
			writeFile(join(userDir, "researcher.md"), "---\nname: researcher\ndescription: User researcher\n---\nuser"),
			writeFile(join(projectDir, "reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\n---\nproject"),
		]);
		const profiles = discoverAgents(root, "all", { configDir, userDir, projectDir });
		assert.deepEqual(
			profiles.map(({ name, description, source, systemPrompt }) => ({ name, description, source, systemPrompt })),
			[
				{ name: "reviewer", description: "Project reviewer", source: "project", systemPrompt: "project" },
				{ name: "researcher", description: "User researcher", source: "user", systemPrompt: "user" },
			],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
