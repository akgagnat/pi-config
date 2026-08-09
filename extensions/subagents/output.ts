function bytePrefix(value: string, maxBytes: number): string {
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

export function truncateOutput(value: string, limits: { maxBytes: number; maxLines: number }): { text: string; truncated: boolean } {
	const totalBytes = Buffer.byteLength(value, "utf8");
	const lines = value.split("\n");
	if (totalBytes <= limits.maxBytes && lines.length <= limits.maxLines) return { text: value, truncated: false };

	const marker = bytePrefix("[Output truncated: full report exceeds configured limits.]", limits.maxBytes);
	if (limits.maxLines <= 1 || Buffer.byteLength(marker, "utf8") >= limits.maxBytes) return { text: marker, truncated: true };
	const availableBytes = Math.max(0, limits.maxBytes - Buffer.byteLength(marker, "utf8") - 1);
	const content = bytePrefix(lines.slice(0, limits.maxLines - 1).join("\n"), availableBytes).replace(/\n+$/g, "");
	return { text: content ? `${content}\n${marker}` : marker, truncated: true };
}
