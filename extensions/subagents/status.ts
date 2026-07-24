export function formatActivityStatus(counts: { running: number; done: number; failed: number }): string | undefined {
	const parts = [
		counts.running ? `${counts.running} running` : "",
		counts.done ? `${counts.done} done` : "",
		counts.failed ? `${counts.failed} failed` : "",
	].filter(Boolean);
	return parts.length ? `subagents: ${parts.join(" · ")}` : undefined;
}
