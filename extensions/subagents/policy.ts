import { relative, resolve } from "node:path";

/** A profile inherits the parent project's trust only within that project. */
export function isTrustedChildCwd(parentCwd: string, childCwd: string): boolean {
	const relativePath = relative(resolve(parentCwd), resolve(childCwd));
	return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes("../"));
}
