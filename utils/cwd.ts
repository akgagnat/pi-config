import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type CwdValidationResult = { cwd: string; error?: string };

export function validateCwd(baseCwd: string, requestedCwd?: string): CwdValidationResult {
	if (requestedCwd !== undefined && requestedCwd.trim() === "") {
		return { cwd: baseCwd, error: "cwd must not be empty" };
	}

	const cwd = requestedCwd === undefined ? baseCwd : isAbsolute(requestedCwd) ? requestedCwd : resolve(baseCwd, requestedCwd);
	try {
		if (!statSync(cwd).isDirectory()) return { cwd, error: `cwd is not a directory: ${cwd}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { cwd, error: `cwd does not exist or is not accessible: ${cwd} (${message})` };
	}
	return { cwd };
}
