import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** A profile inherits trust only within the canonical parent tree, including through symlinks. */
export function isTrustedChildCwd(parentCwd: string, childCwd: string, canonicalize: (path: string) => string = realpathSync): boolean {
	try {
		const relativePath = relative(canonicalize(parentCwd), canonicalize(childCwd));
		return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
	} catch {
		return false;
	}
}
