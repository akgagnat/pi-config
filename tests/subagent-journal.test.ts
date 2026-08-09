import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJournalReader, JOURNAL_SCHEMA_VERSION, RunJournal } from "../extensions/subagents/journal.ts";
import { JobStore, type CreateJobInput } from "../extensions/subagents/job-store.ts";

function input(id: string): CreateJobInput {
	return {
		id,
		name: "private task",
		agent: "worker",
		task: "Sensitive task text",
		cwd: "/work/private",
		parent: { sessionId: "parent", toolCallId: "call" },
		model: { source: "parent", requested: "anthropic/example" },
		delivery: { mode: "foreground", method: "tool-result", consumedByWait: false },
	};
}

const limits = { journalMaxEvents: 2, journalRetention: 1, journalMaxAgeMs: 60_000 };

test("run journal writes a versioned bounded private artifact with a persisted-safe id", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-journal-"));
	try {
		const store = new JobStore({ maxOutputBytes: 4, maxStderrBytes: 4, now: () => 10 });
		store.create(input("sa-0001"));
		const journal = new RunJournal(store, "sa-0001", limits, root, () => 11);
		journal.start();
		store.appendTimeline("sa-0001", { type: "turn-start", turn: 1, at: 1 });
		store.appendTimeline("sa-0001", { type: "turn-end", turn: 1, at: 2 });
		store.appendTimeline("sa-0001", { type: "status", status: "working", at: 3 });
		store.appendStderr("sa-0001", "abcdef");
		store.setOutput("sa-0001", "abcdef");
		store.update("sa-0001", { status: "aborted", stopReason: "aborted" });
		await journal.flush();

		assert.match(journal.artifactId, /^[0-9a-f-]{36}$/);
		assert.notEqual(journal.artifactId, "sa-0001");
		const status = JSON.parse(await readFile(join(root, journal.artifactId, "status.json"), "utf8"));
		assert.equal(status.schemaVersion, JOURNAL_SCHEMA_VERSION);
		assert.equal(status.lifecycle.state, "aborted");
		assert.deepEqual(status.projection, { eventsRetained: 2, eventsTruncated: true });
		assert.deepEqual(status.job.output, { text: "abcd", totalBytes: 6, truncated: true });
		assert.deepEqual(status.job.stderr, { text: "cdef", totalBytes: 6, truncated: true });
		const events = (await readFile(join(root, journal.artifactId, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.length, 2);
		assert.deepEqual(events.map((event) => event.event.type), ["turn-end", "status"]);
		assert.equal((await stat(join(root, journal.artifactId))).mode & 0o777, 0o700);
		assert.equal((await stat(join(root, journal.artifactId, "status.json"))).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("journals clean completed artifacts and tolerate malformed or partial artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-journal-"));
	try {
		const first = new JobStore({ now: () => 1 });
		first.create(input("sa-0001"));
		const firstJournal = new RunJournal(first, "sa-0001", limits, root);
		firstJournal.start();
		first.update("sa-0001", { status: "done" });
		await firstJournal.flush();

		await writeFile(join(root, "not-a-journal"), "partial");
		await writeFile(join(root, "00000000-0000-0000-0000-000000000000"), "partial");
		const second = new JobStore({ now: () => 2 });
		second.create(input("sa-0001"));
		const secondJournal = new RunJournal(second, "sa-0001", limits, root);
		secondJournal.start();
		second.update("sa-0001", { status: "done" });
		await secondJournal.flush();
		const third = new JobStore({ now: () => 3 });
		third.create(input("sa-0001"));
		const thirdJournal = new RunJournal(third, "sa-0001", limits, root);
		thirdJournal.start();
		await thirdJournal.flush();

		assert.notEqual(firstJournal.artifactId, secondJournal.artifactId);
		assert.equal(await createJournalReader(root).read(firstJournal.artifactId), undefined);
		assert.deepEqual((await createJournalReader(root).list()).map((journal) => journal.artifactId), [thirdJournal.artifactId, secondJournal.artifactId]);
		assert.equal(await createJournalReader(root).read("../unsafe"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
