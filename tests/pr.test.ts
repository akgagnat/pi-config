import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import prExtension, {
	buildConfirmationSummary,
	buildDraftDocument,
	buildRepoContext,
	collectUntrackedPreviews,
	executePrFlow,
	extractTextResponse,
	generateDraft,
	formatCommand,
	parseDraftDocument,
	parseGithubRepoSlug,
	requestDraftDocument,
	parseStatusEntries,
	parseStatusEntry,
	quoteShellArg,
	slugifyBranchName,
	selectChangeScope,
	truncateText,
	validateDraft,
	type DraftMetadata,
	type RepoContext,
} from "../extensions/pr.ts";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
};

type Notification = {
	message: string;
	level: string;
};

const ok = (stdout = "", stderr = ""): ExecResult => ({ stdout, stderr, code: 0 });
const fail = (stderr = "", stdout = ""): ExecResult => ({ stdout, stderr, code: 1 });

function createUi(overrides: Partial<ExtensionCommandContext["ui"]> = {}) {
	const notifications: Notification[] = [];
	const editors: Array<{ title: string; content: string }> = [];
	const ui = {
		notify: (message: string, level: string) => {
			notifications.push({ message, level });
		},
		select: async () => undefined,
		editor: async (title: string, content: string) => {
			editors.push({ title, content });
			return undefined;
		},
		confirm: async () => true,
		custom: async () => null,
		...overrides,
	};

	return { ui, notifications, editors };
}

function createCtx(options: {
	mode?: string;
	model?: ExtensionCommandContext["model"] | null;
	ui?: Partial<ExtensionCommandContext["ui"]>;
	modelRegistry?: Partial<ExtensionCommandContext["modelRegistry"]>;
} = {}): ExtensionCommandContext {
	const { ui, notifications, editors } = createUi(options.ui);
	const ctx = {
		mode: options.mode ?? "tui",
		model: options.model === undefined ? ({ id: "test-model", provider: "test-provider" } as ExtensionCommandContext["model"]) : options.model,
		ui,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
			...options.modelRegistry,
		},
	} as unknown as ExtensionCommandContext;

	return Object.assign(ctx, { __notifications: notifications, __editors: editors });
}

function notificationsOf(ctx: ExtensionCommandContext): Notification[] {
	return (ctx as ExtensionCommandContext & { __notifications: Notification[] }).__notifications;
}

function editorsOf(ctx: ExtensionCommandContext): Array<{ title: string; content: string }> {
	return (ctx as ExtensionCommandContext & { __editors: Array<{ title: string; content: string }> }).__editors;
}

function createPi(execImpl: (command: string, args: string[]) => Promise<ExecResult> | ExecResult) {
	const commands = new Map<string, { description: string; handler: NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]> }>();
	const pi = {
		exec: async (command: string, args: string[]) => execImpl(command, args),
		registerCommand: (name: string, options: { description: string; handler: NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]> }) => {
			commands.set(name, options);
		},
	} as ExtensionAPI;

	return { pi, commands };
}

function assertTempFilePath(filePath: string, fileName: string) {
	const tempPath = dirname(filePath);
	assert.equal(basename(filePath), fileName);
	assert.equal(dirname(tempPath), tmpdir());
	assert.match(basename(tempPath), /^pi-pr-/);
}

test("helper functions parse and format git state safely", async () => {
	assert.equal(quoteShellArg("plain/path"), "plain/path");
	assert.equal(quoteShellArg("hello world"), "'hello world'");
	assert.equal(quoteShellArg("it's"), "'it'\\''s'");
	assert.equal(formatCommand("git", ["commit", "-m", "hello world"]), "git commit -m 'hello world'");

	assert.deepEqual(truncateText("Diff", "short", 10), { text: "short" });
	assert.deepEqual(truncateText("Diff", "123456", 4), {
		text: "1234\n\n[... Diff truncated after 4 characters ...]",
		warning: "Diff was truncated before draft generation.",
	});

	const untracked = parseStatusEntry("?? notes.txt");
	assert.equal(untracked.isUntracked, true);
	assert.equal(untracked.hasStaged, false);
	assert.equal(untracked.hasWorktree, true);

	const parsed = parseStatusEntries("R  renamed.txt\0original.txt\0 M dirty.txt\0?? new.txt\0");
	assert.equal(parsed.length, 3);
	assert.equal(parsed[0].raw, "R  original.txt -> renamed.txt");
	assert.equal(parsed[1].raw, " M dirty.txt");
	assert.equal(parsed[2].raw, "?? new.txt");

	assert.equal(
		extractTextResponse([
			{ type: "text", text: "first" },
			{ type: "image" },
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	);
	assert.equal(slugifyBranchName("  Ship PR Draft Support!!!  "), "ship-pr-draft-support");
	assert.equal(slugifyBranchName("!!!"), "update-change");
});

test("draft documents round-trip and invalid documents fail to parse", async () => {
	const draft: DraftMetadata = {
		branch: "feature/pr-draft",
		commit: "Add PR draft helper",
		prTitle: "Add PR draft helper",
		prBody: "### Summary\n- Add tests\n\n### Testing\n- Not run\n\n### Risks / Notes\n- None",
	};

	const document = buildDraftDocument(draft, false);
	assert.match(document, /Keep the four ## headings intact/);
	assert.deepEqual(parseDraftDocument(document), draft);

	const fixedBranchDocument = buildDraftDocument(draft, true);
	assert.match(fixedBranchDocument, /Keep the Branch section equal to the current branch/);
	assert.deepEqual(parseDraftDocument(fixedBranchDocument), draft);
	assert.equal(parseDraftDocument("## Branch\na\n## Branch\nb"), null);
	assert.equal(parseDraftDocument("## Branch\na\n## Commit\nb"), null);
});

test("GitHub repo slugs are derived from common remote URL formats", async () => {
	assert.equal(parseGithubRepoSlug("git@github.com:owner/repo.git"), "owner/repo");
	assert.equal(parseGithubRepoSlug("https://github.com/owner/repo"), "owner/repo");
	assert.equal(parseGithubRepoSlug("ssh://git@github.com/owner/repo.git"), "owner/repo");
	assert.equal(parseGithubRepoSlug("git@gitlab.com:owner/repo.git"), null);
});

test("selectChangeScope prompts only when both staged and unstaged changes exist", async () => {
	let selectCalls = 0;
	const ctx = createCtx({
		ui: {
			select: async () => {
				selectCalls += 1;
				return "Staged only";
			},
		},
	});

	const choice = await selectChangeScope(ctx, [parseStatusEntry("M  staged.ts"), parseStatusEntry(" M dirty.ts")]);
	assert.equal(choice, "staged");
	assert.equal(selectCalls, 1);

	const onlyStaged = await selectChangeScope(ctx, [parseStatusEntry("M  staged.ts")]);
	assert.equal(onlyStaged, "staged");
	assert.equal(selectCalls, 1);
});

test("collectUntrackedPreviews reads text files and omits binary files", async () => {
	const repoRoot = await mkdtemp(join(tmpdir(), "pi-pr-previews-"));
	try {
		await writeFile(join(repoRoot, "notes.txt"), "hello from preview", "utf8");
		await writeFile(join(repoRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));

		const warnings: string[] = [];
		const preview = await collectUntrackedPreviews(
			repoRoot,
			[parseStatusEntry("?? notes.txt"), parseStatusEntry("?? blob.bin")],
			warnings,
		);

		assert.match(preview, /### notes\.txt\nhello from preview/);
		assert.match(preview, /### blob\.bin\n\[BINARY FILE OMITTED\]/);
		assert.deepEqual(warnings, []);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("buildRepoContext assembles selected status, diffs, and untracked previews", async () => {
	const repoRoot = await mkdtemp(join(tmpdir(), "pi-pr-context-"));
	try {
		await writeFile(join(repoRoot, "new-file.txt"), "new file preview", "utf8");

		const ctx = createCtx({
			ui: {
				select: async () => "All changes",
			},
		});
		const commandKey = (command: string, args: string[]) => [command, ...args].join(" ");
		const responses = new Map<string, ExecResult>([
			[commandKey("git", ["rev-parse", "--show-toplevel"]), ok(`${repoRoot}\n`)],
			[commandKey("git", ["-C", repoRoot, "branch", "--show-current"]), ok("main\n")],
			[commandKey("git", ["-C", repoRoot, "rev-parse", "--verify", "main"]), ok("abc123\n")],
			[commandKey("git", ["-C", repoRoot, "remote", "get-url", "origin"]), ok("git@github.com:owner/repo.git\n")],
			[commandKey("git", ["-C", repoRoot, "status", "--porcelain", "-z"]), ok("M  staged.ts\0 M dirty.ts\0?? new-file.txt\0")],
			[commandKey("git", ["-C", repoRoot, "diff", "--staged", "--no-ext-diff", "--no-color"]), ok("staged diff")],
			[commandKey("git", ["-C", repoRoot, "diff", "--no-ext-diff", "--no-color"]), ok("unstaged diff")],
		]);
		const { pi } = createPi((command, args) => {
			const result = responses.get(commandKey(command, args));
			if (!result) {
				throw new Error(`Unexpected exec: ${commandKey(command, args)}`);
			}
			return result;
		});

		const repoContext = await buildRepoContext(pi, ctx);
		assert.ok(repoContext);
		assert.equal(repoContext?.repoRoot, repoRoot);
		assert.equal(repoContext?.repoSlug, "owner/repo");
		assert.equal(repoContext?.changeScope, "all");
		assert.equal(repoContext?.willCreateBranch, true);
		assert.match(repoContext?.contextText ?? "", /Selected git status:\nM  staged.ts\n M dirty.ts\n\?\? new-file.txt/);
		assert.match(repoContext?.contextText ?? "", /Untracked file previews:\n### new-file.txt\nnew file preview/);
		assert.deepEqual(notificationsOf(ctx), []);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("validateDraft rejects empty commit, PR title, and PR body", async () => {
	const ctx = createCtx();
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "main",
		changeScope: "staged",
		statusLines: [],
		willCreateBranch: true,
		warnings: [],
		contextText: "",
	} satisfies RepoContext;

	assert.equal(
		await validateDraft({ exec: async () => ok() } as unknown as ExtensionAPI, ctx, repoContext, {
			branch: "feature/branch",
			commit: "   ",
			prTitle: "title",
			prBody: "body",
		}),
		false,
	);
	assert.equal(
		await validateDraft({ exec: async () => ok() } as unknown as ExtensionAPI, ctx, repoContext, {
			branch: "feature/branch",
			commit: "commit",
			prTitle: "   ",
			prBody: "body",
		}),
		false,
	);
	assert.equal(
		await validateDraft({ exec: async () => ok() } as unknown as ExtensionAPI, ctx, repoContext, {
			branch: "feature/branch",
			commit: "commit",
			prTitle: "title",
			prBody: "   ",
		}),
		false,
	);
	assert.deepEqual(notificationsOf(ctx), [
		{ message: "Commit message cannot be empty", level: "error" },
		{ message: "PR title cannot be empty", level: "error" },
		{ message: "PR body cannot be empty", level: "error" },
	]);
});

test("validateDraft enforces branch reuse rules and checks new branch collisions", async () => {
	const reuseCtx = createCtx();
	const reusedRepo = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "feature/existing",
		changeScope: "staged",
		statusLines: [],
		willCreateBranch: false,
		warnings: [],
		contextText: "",
	} satisfies RepoContext;

	const rejected = await validateDraft(
		{ exec: async () => ok() } as unknown as ExtensionAPI,
		reuseCtx,
		reusedRepo,
		{ branch: "feature/other", commit: "msg", prTitle: "title", prBody: "body" },
	);
	assert.equal(rejected, false);
	assert.deepEqual(notificationsOf(reuseCtx), [
		{ message: "Branch must remain feature/existing for this run", level: "error" },
	]);

	const createCtxForBranch = createCtx();
	const newBranchRepo = { ...reusedRepo, currentBranch: "main", willCreateBranch: true } satisfies RepoContext;
	const createBranchValidationPi = (showRefResult: ExecResult) => ({
		exec: async (_command: string, args: string[]) => {
			if (args.includes("check-ref-format")) {
				return ok();
			}
			if (args.includes("show-ref")) {
				return showRefResult;
			}
			throw new Error(`Unexpected args: ${args.join(" ")}`);
		},
	}) as ExtensionAPI;

	const existingBranch = await validateDraft(
		createBranchValidationPi(ok()),
		createCtxForBranch,
		newBranchRepo,
		{ branch: "feature/new-branch", commit: "msg", prTitle: "title", prBody: "body" },
	);
	assert.equal(existingBranch, false);
	assert.deepEqual(notificationsOf(createCtxForBranch), [
		{ message: "Local branch already exists: feature/new-branch", level: "error" },
	]);

	const validCtx = createCtx();
	const valid = await validateDraft(
		createBranchValidationPi(fail()),
		validCtx,
		newBranchRepo,
		{ branch: "feature/new-branch", commit: "msg", prTitle: "title", prBody: "body" },
	);
	assert.equal(valid, true);
	assert.deepEqual(notificationsOf(validCtx), []);
});

test("requestDraftDocument calls the model with repo context and handles auth or abort edges", async () => {
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "feature/existing",
		changeScope: "staged",
		statusLines: [],
		willCreateBranch: false,
		warnings: [],
		contextText: "repo context",
	} satisfies RepoContext;
	const signal = new AbortController().signal;
	const completeCalls: Array<{
		model: ExtensionCommandContext["model"] | null | undefined;
		systemPrompt: string;
		messageText: string;
		apiKey?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	}> = [];

	const ctx = createCtx();
	const document = await requestDraftDocument(ctx, repoContext, signal, async (model, request, options) => {
		const firstMessage = request.messages[0];
		const firstPart = Array.isArray(firstMessage?.content)
			? firstMessage.content.find((part): part is { type: "text"; text: string } => typeof part !== "string" && part.type === "text")
			: undefined;
		completeCalls.push({
			model,
			systemPrompt: request.systemPrompt ?? "",
			messageText: firstPart?.text ?? "",
			apiKey: options?.apiKey,
			headers: options?.headers ?? {},
			signal: options?.signal,
		});
		return {
			stopReason: "complete",
			content: [
				{ type: "text", text: "first" },
				{ type: "image" },
				{ type: "text", text: "second" },
			],
		} as never;
	});

	assert.equal(document, "first\nsecond");
	assert.equal(completeCalls.length, 1);
	assert.equal(completeCalls[0]?.model, ctx.model);
	assert.match(completeCalls[0]?.systemPrompt ?? "", /Output exactly these markdown sections/);
	assert.equal(completeCalls[0]?.messageText, "repo context");
	assert.equal(completeCalls[0]?.apiKey, "test-key");
	assert.deepEqual(completeCalls[0]?.headers, {});
	assert.equal(completeCalls[0]?.signal, signal);

	const aborted = await requestDraftDocument(ctx, repoContext, signal, async () => ({
		stopReason: "aborted",
		content: [],
	} as never));
	assert.equal(aborted, null);

	const authFailureCtx = createCtx({
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing auth" }) as never,
		},
	});
	await assert.rejects(
		() => requestDraftDocument(authFailureCtx, repoContext, signal, async () => {
			throw new Error("should not be called");
		}),
		/missing auth/,
	);
});

test("generateDraft handles missing models, cancellation, malformed output, and branch reuse", async () => {
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "feature/existing",
		changeScope: "staged",
		statusLines: [],
		willCreateBranch: false,
		warnings: [],
		contextText: "repo context",
	} satisfies RepoContext;

	const missingModelCtx = createCtx({ model: null });
	assert.equal(await generateDraft(missingModelCtx, repoContext), null);
	assert.deepEqual(notificationsOf(missingModelCtx), [
		{ message: "No model selected", level: "error" },
	]);

	const cancelledCtx = createCtx({
		ui: {
			custom: (async () => null) as ExtensionCommandContext["ui"]["custom"],
		},
	});
	assert.equal(await generateDraft(cancelledCtx, repoContext), null);
	assert.deepEqual(notificationsOf(cancelledCtx), [
		{ message: "Cancelled", level: "info" },
	]);

	const malformedCtx = createCtx({
		ui: {
			custom: (async () => "not valid markdown") as ExtensionCommandContext["ui"]["custom"],
		},
	});
	assert.equal(await generateDraft(malformedCtx, repoContext), null);
	assert.equal(editorsOf(malformedCtx)[0]?.title, "/pr generation failed");
	assert.match(editorsOf(malformedCtx)[0]?.content ?? "", /The model did not return the expected markdown sections/);

	const validCtx = createCtx({
		ui: {
			custom: (async () => [
				"## Branch",
				"feature/from-model",
				"",
				"## Commit",
				"Add tests",
				"",
				"## PR Title",
				"Add tests",
				"",
				"## PR Body",
				"### Summary",
				"- Add tests",
			].join("\n")) as ExtensionCommandContext["ui"]["custom"],
		},
	});
	assert.deepEqual(await generateDraft(validCtx, repoContext), {
		branch: "feature/existing",
		commit: "Add tests",
		prTitle: "Add tests",
		prBody: "### Summary\n- Add tests",
	});
});

test("buildConfirmationSummary describes the commands the extension will run", async () => {
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "main",
		changeScope: "all",
		statusLines: [],
		willCreateBranch: true,
		warnings: [],
		contextText: "",
	} satisfies RepoContext;
	const draft: DraftMetadata = {
		branch: "feature/pr-draft",
		commit: "Add coverage",
		prTitle: "Add coverage",
		prBody: "body",
	};

	const summary = buildConfirmationSummary(repoContext, draft);
	assert.match(summary, /git switch -c feature\/pr-draft/);
	assert.match(summary, /git add -A/);
	assert.match(summary, /gh pr create --repo owner\/repo --base main --head feature\/pr-draft/);
});

test("executePrFlow stages, commits, pushes, and creates a draft PR", async () => {
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "main",
		changeScope: "all",
		statusLines: [],
		willCreateBranch: true,
		warnings: [],
		contextText: "",
	} satisfies RepoContext;
	const draft: DraftMetadata = {
		branch: "feature/pr-draft",
		commit: "Add initial test coverage",
		prTitle: "Add initial test coverage",
		prBody: "### Summary\n- Add tests",
	};
	const ctx = createCtx();
	const calls: string[] = [];
	let commitFileContents = "";
	let commitFilePath = "";
	let prBodyFileContents = "";
	let prBodyFilePath = "";
	const { pi } = createPi(async (command, args) => {
		calls.push([command, ...args].join(" "));
		if (command === "git" && args.includes("commit")) {
			commitFilePath = args[args.indexOf("-F") + 1]!;
			commitFileContents = await readFile(commitFilePath, "utf8");
			return ok();
		}
		if (command === "gh") {
			prBodyFilePath = args[args.indexOf("--body-file") + 1]!;
			prBodyFileContents = await readFile(prBodyFilePath, "utf8");
			return ok("https://github.com/owner/repo/pull/123\n");
		}
		return ok();
	});

	await executePrFlow(pi, ctx, repoContext, draft);

	assert.equal(calls[0], "git -C /repo switch -c feature/pr-draft");
	assert.equal(calls[1], "git -C /repo add -A");
	assertTempFilePath(commitFilePath, "commit-message.txt");
	assert.equal(calls[2], `git -C /repo commit -F ${commitFilePath}`);
	assert.equal(calls[3], "git -C /repo push -u origin feature/pr-draft");
	assertTempFilePath(prBodyFilePath, "pr-body.md");
	assert.equal(
		calls[4],
		`gh pr create --repo owner/repo --base main --head feature/pr-draft --title Add initial test coverage --body-file ${prBodyFilePath} --draft`,
	);
	assert.equal(commitFileContents, "Add initial test coverage\n");
	assert.equal(prBodyFileContents, "### Summary\n- Add tests\n");
	assert.deepEqual(notificationsOf(ctx), [
		{ message: "Draft PR created: https://github.com/owner/repo/pull/123", level: "info" },
	]);
});

test("executePrFlow opens a recovery note when PR creation fails after push", async () => {
	const repoContext = {
		repoRoot: "/repo",
		repoSlug: "owner/repo",
		currentBranch: "feature/existing",
		changeScope: "staged",
		statusLines: [],
		willCreateBranch: false,
		warnings: [],
		contextText: "",
	} satisfies RepoContext;
	const draft: DraftMetadata = {
		branch: "feature/existing",
		commit: "Commit message",
		prTitle: "Create PR",
		prBody: "### Summary\n- Body",
	};
	const ctx = createCtx();
	const { pi } = createPi((command, args) => {
		if (command === "git") {
			return ok();
		}
		if (command === "gh") {
			return fail("gh create failed", "partial output");
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	});

	await executePrFlow(pi, ctx, repoContext, draft);

	assert.equal(notificationsOf(ctx).length, 0);
	assert.equal(editorsOf(ctx).length, 1);
	assert.equal(editorsOf(ctx)[0]?.title, "/pr failed");
	assert.match(editorsOf(ctx)[0]?.content ?? "", /Completed steps:\n- Created branch: no\n- Created commit: yes\n- Pushed branch: yes/);
	assert.match(editorsOf(ctx)[0]?.content ?? "", /Suggested manual recovery:/);
	assert.match(editorsOf(ctx)[0]?.content ?? "", /gh pr create --repo owner\/repo --base main --head feature\/existing/);
	assert.match(editorsOf(ctx)[0]?.content ?? "", /### Summary\n- Body/);
});

test("prExtension registers the /pr command and requires interactive mode", async () => {
	const { pi, commands } = createPi(() => ok());
	prExtension(pi);

	const prCommand = commands.get("pr");
	assert.ok(prCommand);
	assert.equal(prCommand?.description, "Create a draft PR from local changes");

	const ctx = createCtx({ mode: "cli" });
	await prCommand?.handler("", ctx);
	assert.deepEqual(notificationsOf(ctx), [
		{ message: "/pr requires interactive mode", level: "error" },
	]);
});

test("/pr handler requires a selected model before doing any work", async () => {
	const { pi, commands } = createPi(() => ok());
	prExtension(pi);

	const ctx = createCtx({ model: null });
	await commands.get("pr")?.handler("", ctx);
	assert.deepEqual(notificationsOf(ctx), [
		{ message: "Select a model before running /pr", level: "error" },
	]);
});

test("/pr handler reports missing GitHub CLI authentication", async () => {
	const { pi, commands } = createPi((command, args) => {
		if (command === "gh" && args[0] === "--version") {
			return ok("gh version 2.0.0");
		}
		if (command === "gh" && args[0] === "auth") {
			return fail("not logged in");
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	});
	prExtension(pi);

	const ctx = createCtx();
	await commands.get("pr")?.handler("", ctx);
	assert.deepEqual(notificationsOf(ctx), [
		{ message: "gh is not authenticated for github.com", level: "error" },
	]);
});

test("/pr handler runs the full happy path end-to-end", async () => {
	const draftDocument = [
		"## Branch",
		"feature/add-tests",
		"",
		"## Commit",
		"Add end-to-end coverage",
		"",
		"## PR Title",
		"Add end-to-end coverage",
		"",
		"## PR Body",
		"### Summary",
		"- Add tests",
		"",
		"### Testing",
		"- Not run",
		"",
		"### Risks / Notes",
		"- None",
	].join("\n");

	// Drive the extension as a black box: the only inputs are the mocked git/gh
	// process results and the UI prompt responses; the only outputs we assert on
	// are the notification and the commands that were actually executed.
	const ctx = createCtx({
		ui: {
			select: async () => "All changes",
			custom: (async () => draftDocument) as ExtensionCommandContext["ui"]["custom"],
			editor: (async (_title: string, content: string) => content) as ExtensionCommandContext["ui"]["editor"],
			confirm: async () => true,
		},
	});

	const calls: string[] = [];
	let commitFileContents = "";
	let prBodyFileContents = "";

	const { pi, commands } = createPi(async (command, args) => {
		calls.push([command, ...args].join(" "));

		if (command === "gh" && args[0] === "--version") {
			return ok("gh version 2.0.0");
		}
		if (command === "gh" && args[0] === "auth") {
			return ok();
		}
		if (command === "gh" && args[0] === "pr") {
			prBodyFileContents = await readFile(args[args.indexOf("--body-file") + 1]!, "utf8");
			return ok("https://github.com/owner/repo/pull/7\n");
		}

		if (command === "git") {
			if (args.includes("--show-toplevel")) {
				return ok("/repo\n");
			}
			if (args.includes("branch") && args.includes("--show-current")) {
				return ok("main\n");
			}
			if (args.includes("rev-parse") && args.includes("--verify")) {
				return ok("abc123\n");
			}
			if (args.includes("remote") && args.includes("get-url")) {
				return ok("git@github.com:owner/repo.git\n");
			}
			if (args.includes("status")) {
				return ok("M  staged.ts\0 M dirty.ts\0");
			}
			if (args.includes("diff")) {
				return ok("diff body");
			}
			if (args.includes("check-ref-format")) {
				return ok();
			}
			if (args.includes("show-ref")) {
				// New branch must not already exist locally.
				return fail();
			}
			if (args.includes("switch") || args.includes("add") || args.includes("push")) {
				return ok();
			}
			if (args.includes("commit")) {
				commitFileContents = await readFile(args[args.indexOf("-F") + 1]!, "utf8");
				return ok();
			}
		}

		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	});

	prExtension(pi);
	await commands.get("pr")?.handler("", ctx);

	assert.deepEqual(notificationsOf(ctx), [
		{ message: "Draft PR created: https://github.com/owner/repo/pull/7", level: "info" },
	]);
	assert.equal(commitFileContents, "Add end-to-end coverage\n");
	assert.match(prBodyFileContents, /### Summary\n- Add tests/);
	assert.ok(calls.includes("git -C /repo switch -c feature/add-tests"));
	assert.ok(calls.includes("git -C /repo add -A"));
	assert.ok(calls.includes("git -C /repo push -u origin feature/add-tests"));
	assert.ok(
		calls.some((call) =>
			call.startsWith("gh pr create --repo owner/repo --base main --head feature/add-tests"),
		),
	);
});
