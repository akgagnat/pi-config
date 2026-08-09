import { resolve } from "node:path";

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/** Returns whether a profile can mutate its working tree. `bash` is treated as mutating. */
export function isMutationCapable(tools: readonly string[] | undefined): boolean {
	return tools?.some((tool) => MUTATING_TOOLS.has(tool)) ?? false;
}

/**
 * Holds one mutation-capable subagent per normalized working directory.
 * `acquire` returns the owning job ID when the directory is already locked.
 */
export class CwdMutationLock {
	private readonly owners = new Map<string, string>();

	acquire(cwd: string, jobId: string): string | undefined {
		const key = resolve(cwd);
		const owner = this.owners.get(key);
		if (owner !== undefined) return owner;
		this.owners.set(key, jobId);
		return undefined;
	}

	release(cwd: string, jobId: string): void {
		const key = resolve(cwd);
		if (this.owners.get(key) === jobId) this.owners.delete(key);
	}
}
