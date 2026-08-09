import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatOutputArtifactReceipt, writeOutputArtifact } from "../extensions/subagents/output-artifact.ts";

test("file-only output is bounded, private, and returns only controlled receipt metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "subagent-output-"));
	try {
		const sentinel = "SECRET_REPORT_CONTENT_" + "é".repeat(100);
		const artifact = await writeOutputArtifact(sentinel, { maxBytes: 80, maxLines: 2 }, root);
		assert.match(artifact.artifactId, /^[0-9a-f-]{36}$/i);
		assert.equal(artifact.path, join(root, artifact.artifactId, "output.txt"));
		assert.ok(artifact.storedBytes <= 80);
		assert.equal(artifact.originalBytes, Buffer.byteLength(sentinel, "utf8"));
		assert.equal(artifact.truncated, true);
		assert.equal((await stat(join(root, artifact.artifactId))).mode & 0o777, 0o700);
		assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
		assert.equal(Buffer.byteLength(await readFile(artifact.path, "utf8"), "utf8"), artifact.storedBytes);
		const receipt = formatOutputArtifactReceipt(artifact);
		assert.doesNotMatch(receipt, /SECRET_REPORT_CONTENT/);
		assert.match(receipt, /Report saved to .*output\.txt/);
		const replacement = await writeOutputArtifact("new report", { maxBytes: 80, maxLines: 2 }, root, { maxArtifacts: 1, maxAgeMs: 60_000 });
		await assert.rejects(readFile(artifact.path), /ENOENT/);
		assert.equal(await readFile(replacement.path, "utf8"), "new report");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("file-only output rejects a symlink root without writing through it", async () => {
	const parent = await mkdtemp(join(tmpdir(), "subagent-output-parent-"));
	const outside = await mkdtemp(join(tmpdir(), "subagent-output-outside-"));
	const root = join(parent, "outputs");
	try {
		await symlink(outside, root, "dir");
		await assert.rejects(writeOutputArtifact("report", { maxBytes: 100, maxLines: 10 }, root), /real directory/);
		await assert.rejects(readFile(join(outside, "output.txt")), /ENOENT/);
	} finally {
		await Promise.all([rm(parent, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
	}
});
