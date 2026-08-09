import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateOutput } from "./output.ts";

export type OutputArtifact = {
	artifactId: string;
	path: string;
	originalBytes: number;
	storedBytes: number;
	truncated: boolean;
};

export function defaultOutputArtifactRoot(): string {
	return join(homedir(), ".pi", "agent", "subagent-outputs");
}

/** Required, atomic persistence for file-only delivery. Partial artifacts are removed on failure. */
export async function writeOutputArtifact(
	output: string,
	limits: { maxBytes: number; maxLines: number },
	root = defaultOutputArtifactRoot(),
	retention: { maxArtifacts: number; maxAgeMs: number; now?: () => number } = { maxArtifacts: 100, maxAgeMs: 30 * 24 * 60 * 60_000 },
): Promise<OutputArtifact> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("File-only output root must be a real directory.");
	await chmod(root, 0o700);
	const artifactId = randomUUID();
	const directory = join(root, artifactId);
	const path = join(directory, "output.txt");
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await mkdir(directory, { mode: 0o700 });
		await chmod(directory, 0o700);
		const bounded = truncateOutput(output, limits);
		await writeFile(temporary, bounded.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		await cleanupOutputArtifacts(root, artifactId, retention).catch(() => {});
		return {
			artifactId,
			path,
			originalBytes: Buffer.byteLength(output, "utf8"),
			storedBytes: Buffer.byteLength(bounded.text, "utf8"),
			truncated: bounded.truncated,
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
		throw new Error(`Failed to persist file-only subagent output: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function cleanupOutputArtifacts(
	root: string,
	preserveId: string,
	retention: { maxArtifacts: number; maxAgeMs: number; now?: () => number },
): Promise<void> {
	const entries = (await readdir(root)).filter((name) => /^[0-9a-f-]{36}$/i.test(name));
	const artifacts = await Promise.all(entries.map(async (id) => ({
		id,
		modifiedAt: await stat(join(root, id)).then((value) => value.mtimeMs).catch(() => 0),
	})));
	artifacts.sort((a, b) => b.modifiedAt - a.modifiedAt);
	const now = (retention.now ?? Date.now)();
	const others = artifacts.filter((item) => item.id !== preserveId);
	const expired = others.filter((item, index) => index >= Math.max(0, retention.maxArtifacts - 1) || now - item.modifiedAt > retention.maxAgeMs);
	await Promise.all(expired.map((item) => rm(join(root, item.id), { recursive: true, force: true })));
}

export function formatOutputArtifactReceipt(artifact: OutputArtifact): string {
	return `Report saved to ${artifact.path} (${artifact.storedBytes}/${artifact.originalBytes} bytes${artifact.truncated ? ", truncated" : ""}; artifact ${artifact.artifactId}).`;
}
