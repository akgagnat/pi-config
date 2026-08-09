import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentProfile } from "./profiles.ts";

function isContained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function childExtensionArgs(paths: readonly string[]): string[] {
	return paths.flatMap((path) => ["--extension", path]);
}

/** Resolve profile-owned extension paths without allowing filesystem or symlink escape. */
export function resolveChildExtensions(profile: AgentProfile): string[] {
	const paths = profile.extensions ?? [];
	if (paths.length === 0) return [];
	const root = realpathSync(profile.trustRoot);
	return paths.map((configuredPath) => {
		if (!configuredPath || configuredPath.includes("\0") || isAbsolute(configuredPath)) {
			throw new Error(`Invalid child extension path for ${profile.name}: ${configuredPath || "(empty)"}`);
		}
		const lexicalTarget = resolve(root, configuredPath);
		if (!isContained(root, lexicalTarget)) throw new Error(`Child extension path escapes its trusted root: ${configuredPath}`);
		let target: string;
		try {
			target = realpathSync(lexicalTarget);
			if (!statSync(target).isFile()) throw new Error("not a regular file");
		} catch (error) {
			throw new Error(`Invalid child extension ${configuredPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isContained(root, target)) throw new Error(`Child extension symlink escapes its trusted root: ${configuredPath}`);
		if (!/\.[cm]?[jt]s$/i.test(target)) throw new Error(`Child extension must be a JavaScript or TypeScript file: ${configuredPath}`);
		return target;
	});
}
