import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE_BRANCH = "main";
const REMOTE_NAME = "origin";
const MAX_STATUS_CHARS = 4_000;
const MAX_DIFF_CHARS = 14_000;
const MAX_UNTRACKED_PREVIEW_CHARS = 8_000;
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_FILE_BYTES = 4_000;

const PR_PLANNER_SKILL_URL = new URL("../skills/pr-planner/SKILL.md", import.meta.url);

const PR_PLANNER_OUTPUT_CONTRACT = `You are preparing one git commit and one draft pull request from a selected set of local changes.

Output exactly these markdown sections, once each:
## Branch
## Commit
## PR Title
## PR Body`;

const PR_PLANNER_FALLBACK_POLICY = `Draft one branch name, one commit message, one PR title, and one PR body from the provided change context.

- Use lowercase kebab-case for a new branch name.
- Write an imperative, specific commit message.
- Write a concise, reviewer-friendly PR title.
- In the PR body, include these subsections:
  ### Summary
  ### Testing
  ### Risks / Notes
- If testing information is unavailable, say "Not run".
- If risk/notes are unavailable, say "None".
- Use only the provided change context. Diff text may be truncated; do not invent unsupported details.`;

type ChangeScope = "staged" | "all";

type DraftMetadata = {
	branch: string;
	commit: string;
	prTitle: string;
	prBody: string;
};

type ParsedStatusLine = {
	raw: string;
	indexStatus: string;
	worktreeStatus: string;
	path: string;
	isUntracked: boolean;
	hasStaged: boolean;
	hasWorktree: boolean;
};

const STATUS_WITH_SECOND_PATH = new Set(["R", "C"]);

type RepoContext = {
	repoRoot: string;
	repoSlug: string;
	currentBranch: string;
	changeScope: ChangeScope;
	statusLines: ParsedStatusLine[];
	willCreateBranch: boolean;
	warnings: string[];
	contextText: string;
};

type StepState = {
	createdBranch: boolean;
	committed: boolean;
	pushed: boolean;
};

class CommandFailure extends Error {
	constructor(
		readonly step: string,
		readonly command: string,
		readonly args: string[],
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(`Failed during ${step}`);
	}
}

const formatCommand = (command: string, args: string[]): string =>
	[command, ...args.map(quoteShellArg)].join(" ");

const quoteShellArg = (value: string): string => {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

const truncateText = (
	label: string,
	value: string,
	maxChars: number,
	wasTruncated = value.length > maxChars,
): { text: string; warning?: string } => {
	if (!wasTruncated) {
		return { text: value };
	}

	return {
		text: `${value.slice(0, maxChars)}\n\n[... ${label} truncated after ${maxChars.toLocaleString()} characters ...]`,
		warning: `${label} was truncated before draft generation.`,
	};
};

const formatStatusPath = (path: string, originalPath?: string): string =>
	originalPath ? `${originalPath} -> ${path}` : path;

const parseStatusEntry = (entry: string, originalPath?: string): ParsedStatusLine => {
	const indexStatus = entry[0] ?? " ";
	const worktreeStatus = entry[1] ?? " ";
	const path = entry.slice(3);
	const isUntracked = indexStatus === "?" && worktreeStatus === "?";

	return {
		raw: `${indexStatus}${worktreeStatus} ${formatStatusPath(path, originalPath)}`,
		indexStatus,
		worktreeStatus,
		path,
		isUntracked,
		hasStaged: !isUntracked && indexStatus !== " ",
		hasWorktree: worktreeStatus !== " ",
	};
};

const parseStatusEntries = (stdout: string): ParsedStatusLine[] => {
	// `git status --porcelain -z` emits NUL-delimited paths without C-style quoting.
	// Rename/copy entries use two path fields: `<new-path>\0<old-path>\0`.
	const entries = stdout.split("\0");
	const lines: ParsedStatusLine[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry) {
			continue;
		}

		const indexStatus = entry[0] ?? " ";
		const worktreeStatus = entry[1] ?? " ";
		const hasSecondPath = STATUS_WITH_SECOND_PATH.has(indexStatus) || STATUS_WITH_SECOND_PATH.has(worktreeStatus);
		const originalPath = hasSecondPath ? entries[index + 1] || undefined : undefined;
		if (hasSecondPath) {
			index += 1;
		}

		lines.push(parseStatusEntry(entry, originalPath));
	}

	return lines;
};

const isProbablyBinary = (buffer: Buffer): boolean => buffer.includes(0);

const extractTextResponse = (content: Array<{ type: string; text?: string }>): string =>
	content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();

const slugifyBranchName = (value: string): string => {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");

	return slug || "update-change";
};

const buildDraftDocument = (draft: DraftMetadata, branchIsFixed: boolean): string => {
	const fixedNote = branchIsFixed
		? "<!-- Keep the Branch section equal to the current branch; this run reuses the existing branch. -->\n\n"
		: "<!-- Keep the four ## headings intact so /pr can parse this draft after you edit it. -->\n\n";

	return [
		fixedNote,
		"## Branch",
		draft.branch,
		"",
		"## Commit",
		draft.commit,
		"",
		"## PR Title",
		draft.prTitle,
		"",
		"## PR Body",
		draft.prBody,
		"",
	].join("\n");
};

const parseDraftDocument = (value: string): DraftMetadata | null => {
	const sections = new Map<string, string[]>();
	let currentSection: string | null = null;

	for (const line of value.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(Branch|Commit|PR Title|PR Body)\s*$/);
		if (heading) {
			currentSection = heading[1];
			if (sections.has(currentSection)) {
				return null;
			}
			sections.set(currentSection, []);
			continue;
		}

		if (!currentSection) {
			continue;
		}

		sections.get(currentSection)?.push(line);
	}

	const branch = sections.get("Branch")?.join("\n").trim();
	const commit = sections.get("Commit")?.join("\n").trim();
	const prTitle = sections.get("PR Title")?.join("\n").trim();
	const prBody = sections.get("PR Body")?.join("\n").trim();

	if (!branch || !commit || !prTitle || !prBody) {
		return null;
	}

	return { branch, commit, prTitle, prBody };
};

const parseGithubRepoSlug = (remoteUrl: string): string | null => {
	const trimmed = remoteUrl.trim();
	const patterns = [
		/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
		/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
	];

	for (const pattern of patterns) {
		const match = trimmed.match(pattern);
		if (match) {
			return match[1];
		}
	}

	return null;
};

const execChecked = async (
	pi: ExtensionAPI,
	step: string,
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> => {
	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		throw new CommandFailure(step, command, args, result.stdout, result.stderr);
	}
	return result;
};

type PrPlannerPolicyReader = (path: URL, encoding: BufferEncoding) => Promise<string>;
type PrPlannerPolicyLoader = () => Promise<string>;

const buildPrPlannerSystemPrompt = (policy: string): string =>
	`${PR_PLANNER_OUTPUT_CONTRACT}\n\n${policy.trim()}`;

const loadPrPlannerPolicy = async (
	readText: PrPlannerPolicyReader = (path, encoding) => readFile(path, encoding),
): Promise<string> => {
	try {
		const skillText = (await readText(PR_PLANNER_SKILL_URL, "utf8")).trim();
		return skillText || PR_PLANNER_FALLBACK_POLICY;
	} catch {
		return PR_PLANNER_FALLBACK_POLICY;
	}
};

const selectChangeScope = async (ctx: ExtensionCommandContext, statusLines: ParsedStatusLine[]): Promise<ChangeScope | null> => {
	const hasStaged = statusLines.some((line) => line.hasStaged);
	const hasUnstagedOrUntracked = statusLines.some((line) => line.hasWorktree);

	if (hasStaged && hasUnstagedOrUntracked) {
		const choice = await ctx.ui.select("Choose changes to include", ["Staged only", "All changes"]);
		if (!choice) {
			return null;
		}
		return choice === "Staged only" ? "staged" : "all";
	}

	if (hasStaged) {
		return "staged";
	}

	return "all";
};

const collectUntrackedPreviews = async (
	repoRoot: string,
	statusLines: ParsedStatusLine[],
	warnings: string[],
): Promise<string> => {
	const previews: string[] = [];
	const untracked = statusLines.filter((line) => line.isUntracked).slice(0, MAX_UNTRACKED_FILES);

	for (const line of untracked) {
		const absolutePath = resolve(repoRoot, line.path);
		try {
			const fileHandle = await open(absolutePath, "r");
			try {
				const previewBuffer = Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1);
				const { bytesRead } = await fileHandle.read(previewBuffer, 0, previewBuffer.length, 0);
				const sampledBuffer = previewBuffer.subarray(0, bytesRead);
				if (isProbablyBinary(sampledBuffer)) {
					previews.push(`### ${line.path}\n[BINARY FILE OMITTED]`);
					continue;
				}

				const previewBytesWereTruncated = bytesRead > MAX_UNTRACKED_FILE_BYTES;
				const previewTextBuffer = sampledBuffer.subarray(0, MAX_UNTRACKED_FILE_BYTES);
				const text = previewTextBuffer.toString("utf8");
				const truncated = truncateText(
					`Preview for ${line.path}`,
					text,
					MAX_UNTRACKED_FILE_BYTES,
					previewBytesWereTruncated,
				);
				if (truncated.warning) {
					warnings.push(truncated.warning);
				}
				previews.push(`### ${line.path}\n${truncated.text}`);
			} finally {
				await fileHandle.close();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			previews.push(`### ${line.path}\n[UNABLE TO READ FILE: ${message}]`);
		}
	}

	const combined = previews.join("\n\n");
	const truncated = truncateText("Untracked file previews", combined, MAX_UNTRACKED_PREVIEW_CHARS);
	if (truncated.warning) {
		warnings.push(truncated.warning);
	}
	if (statusLines.filter((line) => line.isUntracked).length > MAX_UNTRACKED_FILES) {
		warnings.push(`Only the first ${MAX_UNTRACKED_FILES} untracked files were previewed.`);
	}
	return truncated.text;
};

const buildRepoContext = async (pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<RepoContext | null> => {
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) {
		ctx.ui.notify("/pr requires a git repository", "error");
		return null;
	}

	const repoRoot = rootResult.stdout.trim();
	const currentBranchResult = await execChecked(pi, "read current branch", "git", ["-C", repoRoot, "branch", "--show-current"]);
	const currentBranch = currentBranchResult.stdout.trim();
	if (!currentBranch) {
		ctx.ui.notify("/pr does not support detached HEAD in v1", "error");
		return null;
	}

	const mainCheck = await pi.exec("git", ["-C", repoRoot, "rev-parse", "--verify", BASE_BRANCH]);
	if (mainCheck.code !== 0) {
		ctx.ui.notify(`This extension assumes a local ${BASE_BRANCH} branch.`, "error");
		return null;
	}

	const remoteUrlResult = await execChecked(pi, "read origin remote", "git", ["-C", repoRoot, "remote", "get-url", REMOTE_NAME]);
	const repoSlug = parseGithubRepoSlug(remoteUrlResult.stdout);
	if (!repoSlug) {
		ctx.ui.notify(`Could not derive a GitHub repo slug from ${REMOTE_NAME}.`, "error");
		return null;
	}

	const statusResult = await execChecked(pi, "read git status", "git", ["-C", repoRoot, "status", "--porcelain", "-z"]);
	const statusLines = parseStatusEntries(statusResult.stdout);

	if (statusLines.length === 0) {
		ctx.ui.notify("No local changes found", "warning");
		return null;
	}

	const changeScope = await selectChangeScope(ctx, statusLines);
	if (!changeScope) {
		ctx.ui.notify("Cancelled", "info");
		return null;
	}

	const warnings: string[] = [];
	const selectedStatusLines = changeScope === "all" ? statusLines : statusLines.filter((line) => line.hasStaged);
	const statusText = truncateText(
		"Git status",
		selectedStatusLines.map((line) => line.raw).join("\n"),
		MAX_STATUS_CHARS,
	);
	if (statusText.warning) {
		warnings.push(statusText.warning);
	}

	const stagedDiffResult = await execChecked(pi, "read staged diff", "git", [
		"-C",
		repoRoot,
		"diff",
		"--staged",
		"--no-ext-diff",
		"--no-color",
	]);
	const stagedDiff = truncateText("Staged diff", stagedDiffResult.stdout.trim(), MAX_DIFF_CHARS);
	if (stagedDiff.warning) {
		warnings.push(stagedDiff.warning);
	}

	let unstagedDiffText = "";
	let untrackedPreviewText = "";
	if (changeScope === "all") {
		const unstagedDiffResult = await execChecked(pi, "read unstaged diff", "git", [
			"-C",
			repoRoot,
			"diff",
			"--no-ext-diff",
			"--no-color",
		]);
		const unstagedDiff = truncateText("Unstaged diff", unstagedDiffResult.stdout.trim(), MAX_DIFF_CHARS);
		if (unstagedDiff.warning) {
			warnings.push(unstagedDiff.warning);
		}
		unstagedDiffText = unstagedDiff.text;
		untrackedPreviewText = await collectUntrackedPreviews(repoRoot, statusLines, warnings);
	}

	const willCreateBranch = currentBranch === BASE_BRANCH;
	const contextParts = [
		`Repository: ${repoSlug}`,
		`Current branch: ${currentBranch}`,
		`Base branch: ${BASE_BRANCH}`,
		willCreateBranch
			? "Branch action: Create a new feature branch."
			: `Branch action: Reuse the current branch exactly: ${currentBranch}`,
		changeScope === "staged"
			? "Change scope: staged changes only."
			: "Change scope: all current working tree changes (staged, unstaged, and untracked).",
		warnings.length > 0 ? `Warnings:\n- ${warnings.join("\n- ")}` : "",
		`Selected git status:\n${statusText.text || "(none)"}`,
		`Staged diff:\n${stagedDiff.text || "(none)"}`,
		changeScope === "all" ? `Unstaged diff:\n${unstagedDiffText || "(none)"}` : "",
		changeScope === "all" && untrackedPreviewText ? `Untracked file previews:\n${untrackedPreviewText}` : "",
	].filter(Boolean);

	return {
		repoRoot,
		repoSlug,
		currentBranch,
		changeScope,
		statusLines,
		willCreateBranch,
		warnings,
		contextText: contextParts.join("\n\n"),
	};
};

const requestDraftDocument = async (
	ctx: ExtensionCommandContext,
	repoContext: RepoContext,
	signal: AbortSignal,
	completeFn: typeof complete = complete,
	loadPolicy: PrPlannerPolicyLoader = loadPrPlannerPolicy,
): Promise<string | null> => {
	if (!ctx.model) {
		throw new Error("No model selected");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	}

	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: repoContext.contextText }],
		timestamp: Date.now(),
	};

	const response = await completeFn(
		ctx.model,
		{ systemPrompt: buildPrPlannerSystemPrompt(await loadPolicy()), messages: [message] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") {
		return null;
	}

	return extractTextResponse(response.content);
};

const generateDraft = async (
	ctx: ExtensionCommandContext,
	repoContext: RepoContext,
): Promise<DraftMetadata | null> => {
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return null;
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating PR draft using ${ctx.model!.id}...`);
		loader.onAbort = () => done(null);

		requestDraftDocument(ctx, repoContext, loader.signal)
			.then(done)
			.catch((error) => {
				console.error("/pr generation failed", error);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		ctx.ui.notify("Cancelled", "info");
		return null;
	}

	const parsed = parseDraftDocument(result);
	if (!parsed) {
		await ctx.ui.editor(
			"/pr generation failed",
			`The model did not return the expected markdown sections.\n\nRaw output:\n\n${result}`,
		);
		return null;
	}

	return {
		branch: repoContext.willCreateBranch ? parsed.branch || slugifyBranchName(parsed.prTitle) : repoContext.currentBranch,
		commit: parsed.commit,
		prTitle: parsed.prTitle,
		prBody: parsed.prBody,
	};
};

const validateDraft = async (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoContext: RepoContext,
	draft: DraftMetadata,
): Promise<boolean> => {
	if (!draft.commit.trim()) {
		ctx.ui.notify("Commit message cannot be empty", "error");
		return false;
	}

	if (!draft.prTitle.trim()) {
		ctx.ui.notify("PR title cannot be empty", "error");
		return false;
	}

	if (!draft.prBody.trim()) {
		ctx.ui.notify("PR body cannot be empty", "error");
		return false;
	}

	if (!repoContext.willCreateBranch && draft.branch !== repoContext.currentBranch) {
		ctx.ui.notify(`Branch must remain ${repoContext.currentBranch} for this run`, "error");
		return false;
	}

	if (repoContext.willCreateBranch && draft.branch === BASE_BRANCH) {
		ctx.ui.notify(`New branch name cannot be ${BASE_BRANCH}`, "error");
		return false;
	}

	const branchCheck = await pi.exec("git", ["-C", repoContext.repoRoot, "check-ref-format", "--branch", draft.branch]);
	if (branchCheck.code !== 0) {
		ctx.ui.notify(`Invalid branch name: ${draft.branch}`, "error");
		return false;
	}

	if (repoContext.willCreateBranch) {
		const existingLocalBranch = await pi.exec("git", [
			"-C",
			repoContext.repoRoot,
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${draft.branch}`,
		]);
		if (existingLocalBranch.code === 0) {
			ctx.ui.notify(`Local branch already exists: ${draft.branch}`, "error");
			return false;
		}
	}

	return true;
};

const buildConfirmationSummary = (repoContext: RepoContext, draft: DraftMetadata): string => {
	const commands = [
		repoContext.willCreateBranch ? formatCommand("git", ["switch", "-c", draft.branch]) : `Reuse current branch: ${draft.branch}`,
		repoContext.changeScope === "all" ? formatCommand("git", ["add", "-A"]) : "Use existing staged changes only (no git add)",
		formatCommand("git", ["commit", "-F", "<temp-commit-message-file>"]),
		formatCommand("git", ["push", "-u", REMOTE_NAME, draft.branch]),
		formatCommand("gh", [
			"pr",
			"create",
			"--repo",
			repoContext.repoSlug,
			"--base",
			BASE_BRANCH,
			"--head",
			draft.branch,
			"--title",
			draft.prTitle,
			"--body-file",
			"<temp-pr-body-file>",
			"--draft",
		]),
	].join("\n");

	return [
		`Repo: ${repoContext.repoSlug}`,
		`Current branch: ${repoContext.currentBranch}`,
		`Base branch: ${BASE_BRANCH}`,
		`Change scope: ${repoContext.changeScope === "all" ? "all changes" : "staged only"}`,
		`Branch: ${draft.branch}`,
		`Commit: ${draft.commit.split("\n")[0]}`,
		`PR title: ${draft.prTitle}`,
		"",
		"Commands to run:",
		commands,
	].join("\n");
};

const buildRecoveryNote = (
	repoContext: RepoContext,
	draft: DraftMetadata,
	failure: CommandFailure,
	state: StepState,
): string => {
	const manualPrCommand = formatCommand("gh", [
		"pr",
		"create",
		"--repo",
		repoContext.repoSlug,
		"--base",
		BASE_BRANCH,
		"--head",
		draft.branch,
		"--title",
		draft.prTitle,
		"--body-file",
		"./pr-body.md",
		"--draft",
	]);

	return [
		`/pr failed during: ${failure.step}`,
		"",
		"Completed steps:",
		`- Created branch: ${state.createdBranch ? "yes" : "no"}`,
		`- Created commit: ${state.committed ? "yes" : "no"}`,
		`- Pushed branch: ${state.pushed ? "yes" : "no"}`,
		"",
		"Failed command:",
		formatCommand(failure.command, failure.args),
		"",
		failure.stdout ? `stdout:\n${failure.stdout.trim()}\n` : "",
		failure.stderr ? `stderr:\n${failure.stderr.trim()}\n` : "",
		state.pushed
			? [
				"Suggested manual recovery:",
				`1. Save the PR body below to ./pr-body.md`,
				`2. Run: ${manualPrCommand}`,
				"",
				"PR body:",
				draft.prBody,
			].join("\n")
			: "Review the failed step and continue manually from the current repository state.",
	].filter(Boolean).join("\n");
};

const executePrFlow = async (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoContext: RepoContext,
	draft: DraftMetadata,
): Promise<void> => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-pr-"));
	const commitPath = join(tempDir, "commit-message.txt");
	const prBodyPath = join(tempDir, "pr-body.md");
	const stepState: StepState = {
		createdBranch: false,
		committed: false,
		pushed: false,
	};

	await writeFile(commitPath, `${draft.commit.trim()}\n`, "utf8");
	await writeFile(prBodyPath, `${draft.prBody.trim()}\n`, "utf8");

	try {
		if (repoContext.willCreateBranch) {
			await execChecked(pi, "create branch", "git", ["-C", repoContext.repoRoot, "switch", "-c", draft.branch]);
			stepState.createdBranch = true;
		}

		if (repoContext.changeScope === "all") {
			await execChecked(pi, "stage changes", "git", ["-C", repoContext.repoRoot, "add", "-A"]);
		}

		await execChecked(pi, "create commit", "git", ["-C", repoContext.repoRoot, "commit", "-F", commitPath]);
		stepState.committed = true;

		await execChecked(pi, "push branch", "git", ["-C", repoContext.repoRoot, "push", "-u", REMOTE_NAME, draft.branch]);
		stepState.pushed = true;

		const prCreateResult = await execChecked(pi, "create pull request", "gh", [
			"pr",
			"create",
			"--repo",
			repoContext.repoSlug,
			"--base",
			BASE_BRANCH,
			"--head",
			draft.branch,
			"--title",
			draft.prTitle,
			"--body-file",
			prBodyPath,
			"--draft",
		]);

		const prUrl = prCreateResult.stdout
			.split(/\s+/)
			.map((value) => value.trim())
			.find((value) => value.startsWith("http://") || value.startsWith("https://"));

		ctx.ui.notify(prUrl ? `Draft PR created: ${prUrl}` : "Draft PR created", "info");
	} catch (error) {
		if (error instanceof CommandFailure) {
			await ctx.ui.editor("/pr failed", buildRecoveryNote(repoContext, draft, error, stepState));
			return;
		}
		throw error;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
};

export {
	CommandFailure,
	formatCommand,
	quoteShellArg,
	truncateText,
	formatStatusPath,
	parseStatusEntry,
	parseStatusEntries,
	isProbablyBinary,
	extractTextResponse,
	slugifyBranchName,
	buildDraftDocument,
	parseDraftDocument,
	parseGithubRepoSlug,
	execChecked,
	buildPrPlannerSystemPrompt,
	loadPrPlannerPolicy,
	selectChangeScope,
	collectUntrackedPreviews,
	buildRepoContext,
	requestDraftDocument,
	generateDraft,
	validateDraft,
	buildConfirmationSummary,
	buildRecoveryNote,
	executePrFlow,
};

export type {
	ChangeScope,
	DraftMetadata,
	ParsedStatusLine,
	RepoContext,
	StepState,
};

export default function prExtension(pi: ExtensionAPI) {
	pi.registerCommand("pr", {
		description: "Create a draft PR from local changes",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/pr requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("Select a model before running /pr", "error");
				return;
			}

			const ghVersion = await pi.exec("gh", ["--version"]);
			if (ghVersion.code !== 0) {
				ctx.ui.notify("/pr requires GitHub CLI (gh)", "error");
				return;
			}

			const ghAuth = await pi.exec("gh", ["auth", "status", "--hostname", "github.com"]);
			if (ghAuth.code !== 0) {
				ctx.ui.notify("gh is not authenticated for github.com", "error");
				return;
			}

			const repoContext = await buildRepoContext(pi, ctx);
			if (!repoContext) {
				return;
			}

			const generatedDraft = await generateDraft(ctx, repoContext);
			if (!generatedDraft) {
				return;
			}

			const editedDocument = await ctx.ui.editor(
				"Review /pr draft",
				buildDraftDocument(generatedDraft, !repoContext.willCreateBranch),
			);
			if (editedDocument === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedDraft = parseDraftDocument(editedDocument);
			if (!editedDraft) {
				ctx.ui.notify("Could not parse the edited draft. Keep the four ## headings intact.", "error");
				return;
			}

			if (!(await validateDraft(pi, ctx, repoContext, editedDraft))) {
				return;
			}

			const confirmed = await ctx.ui.confirm("Create draft PR?", buildConfirmationSummary(repoContext, editedDraft));
			if (!confirmed) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await executePrFlow(pi, ctx, repoContext, editedDraft);
		},
	});
}
