import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResultDelivery } from "../extensions/subagents/result-delivery.ts";
import { JobManager } from "../extensions/subagents/jobs.ts";
import { discoverAgents, parseFrontmatter } from "../extensions/subagents/profiles.ts";

test("result delivery defers completed jobs and lets an explicit wait consume them", () => {
	const delivery = new ResultDelivery<{ id: string }>();
	delivery.defer({ id: "sa-1" });
	delivery.consume(["sa-1"]);
	assert.deepEqual(delivery.drain(), []);
	delivery.defer({ id: "sa-2" });
	assert.deepEqual(delivery.drain(), [{ id: "sa-2" }]);
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
