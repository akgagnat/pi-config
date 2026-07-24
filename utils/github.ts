export function parseGithubRepoSlug(remoteUrl: string): string | null {
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
}
