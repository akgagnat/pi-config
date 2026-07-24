export type TextPart = { type: string; text?: string };

export function truncateMiddle(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const keep = Math.floor((maxChars - 20) / 2);
	return `${value.slice(0, keep)}\n... truncated ...\n${value.slice(-keep)}`;
}

export function extractTextResponse(content: TextPart[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}
