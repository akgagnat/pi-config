export type TextPart = { type: string; text?: string };

export function truncateMiddle(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const keep = Math.floor((maxChars - 20) / 2);
	return `${value.slice(0, keep)}\n... truncated ...\n${value.slice(-keep)}`;
}

export function truncateText(
	label: string,
	value: string,
	maxChars: number,
	wasTruncated = value.length > maxChars,
	warningContext = "draft generation",
): { text: string; warning?: string } {
	if (!wasTruncated) {
		return { text: value };
	}

	return {
		text: `${value.slice(0, maxChars)}\n\n[... ${label} truncated after ${maxChars.toLocaleString()} characters ...]`,
		warning: `${label} was truncated before ${warningContext}.`,
	};
}

export function extractTextResponse(content: TextPart[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}
