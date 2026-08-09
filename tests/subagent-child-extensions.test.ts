import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { childExtensionArgs, resolveChildExtensions } from "../extensions/subagents/child-extensions.ts";
import type { AgentProfile } from "../extensions/subagents/profiles.ts";
import { isTrustedChildCwd } from "../extensions/subagents/policy.ts";

function profile(trustRoot: string, extensions?: string[]): AgentProfile {
	return { name: "worker", description: "worker", systemPrompt: "work", source: "config", filePath: join(trustRoot, "agents/worker.md"), trustRoot, tools: ["read", "contact_supervisor"], extensions };
}

test("default discovery stays disabled and only explicit profile extensions become CLI arguments", () => {
	assert.deepEqual(childExtensionArgs([]), []);
	assert.deepEqual(childExtensionArgs(["/trusted/contact.ts"]), ["--extension", "/trusted/contact.ts"]);
});

test("canonical child cwd policy rejects a symlink that escapes the trusted project", async () => {
	const root = await mkdtemp(join(tmpdir(), "child-cwd-root-"));
	const outside = await mkdtemp(join(tmpdir(), "child-cwd-outside-"));
	try {
		await symlink(outside, join(root, "escaped"), "dir");
		assert.equal(isTrustedChildCwd(root, join(root, "escaped")), false);
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
	}
});

test("profile child extensions resolve only regular files contained by their trust root", async () => {
	const root = await mkdtemp(join(tmpdir(), "child-ext-root-"));
	const outside = await mkdtemp(join(tmpdir(), "child-ext-outside-"));
	try {
		await mkdir(join(root, "extensions"));
		await writeFile(join(root, "extensions/allowed.ts"), "export default () => {};");
		await writeFile(join(outside, "outside.ts"), "export default () => {};");
		await symlink(join(outside, "outside.ts"), join(root, "extensions/escape.ts"));
		assert.deepEqual(resolveChildExtensions(profile(root, ["extensions/allowed.ts"])), [join(root, "extensions/allowed.ts")]);
		assert.throws(() => resolveChildExtensions(profile(root, ["../outside.ts"])), /escapes its trusted root/);
		assert.throws(() => resolveChildExtensions(profile(root, [join(outside, "outside.ts")])), /Invalid child extension path/);
		assert.throws(() => resolveChildExtensions(profile(root, ["extensions/escape.ts"])), /symlink escapes/);
		assert.throws(() => resolveChildExtensions(profile(root, ["extensions/missing.ts"])), /Invalid child extension/);
		assert.deepEqual(resolveChildExtensions(profile(root)), []);
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
	}
});
