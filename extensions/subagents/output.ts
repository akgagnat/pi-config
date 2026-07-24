export function truncateOutput(value: string, limits: { maxBytes: number; maxLines: number }): { text: string; truncated: boolean } {
	const lines = value.split("\n");
	const limitedLines = lines.slice(0, limits.maxLines);
	let content = limitedLines.join("\n");
	let bytes = Buffer.byteLength(content, "utf8");
	let byteTruncated = false;
	if (bytes > limits.maxBytes) {
		let kept = "";
		for (const char of content) {
			if (Buffer.byteLength(kept + char, "utf8") > limits.maxBytes) break;
			kept += char;
		}
		content = kept;
		bytes = Buffer.byteLength(content, "utf8");
		byteTruncated = true;
	}
	const lineTruncated = lines.length > limits.maxLines;
	if (!lineTruncated && !byteTruncated) return { text: content, truncated: false };
	const reason = byteTruncated
		? `${bytes} of ${Buffer.byteLength(value, "utf8")} bytes shown.`
		: `${limitedLines.length} of ${lines.length} lines shown.`;
	return { text: `${content}\n\n[Output truncated: ${reason}]`, truncated: true };
}
