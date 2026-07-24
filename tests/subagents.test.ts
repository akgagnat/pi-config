import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents, parseFrontmatter } from "../extensions/subagents/profiles.ts";

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
