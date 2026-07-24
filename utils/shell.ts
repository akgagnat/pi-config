export function quoteShellArg(value: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map(quoteShellArg)].join(" ");
}
