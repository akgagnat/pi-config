import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type AgentSource = "config" | "user" | "project";
export type AgentScope = AgentSource | "all";

export type AgentProfile = {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	trustRoot: string;
	model?: string;
	tools?: string[];
	extensions?: string[];
};

export function parseFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
	if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
	const end = markdown.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: markdown };

	const frontmatter: Record<string, string> = {};
	for (const line of markdown.slice(4, end).trim().split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match) frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
	}
	return { frontmatter, body: markdown.slice(end + "\n---".length).replace(/^(?:\r?\n)+/, "") };
}

function loadProfiles(dir: string, source: AgentSource): AgentProfile[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.flatMap((entry) => {
			const filePath = join(dir, entry.name);
			const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
			if (!frontmatter.name || !frontmatter.description) return [];
			return [{
				name: frontmatter.name,
				description: frontmatter.description,
				systemPrompt: body.trim(),
				source,
				filePath,
				trustRoot: dirname(dir),
				model: frontmatter.model,
				tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
				extensions: frontmatter.extensions?.split(",").map((extension) => extension.trim()).filter(Boolean),
			}];
		});
}

export function findProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	directories = {
		configDir: fileURLToPath(new URL("../../agents", import.meta.url)),
		userDir: join(getAgentDir(), "agents"),
		projectDir: findProjectAgentsDir(cwd),
	},
): AgentProfile[] {
	const sources: Array<[string | null, AgentSource]> = [];
	if (scope === "config" || scope === "all") sources.push([directories.configDir, "config"]);
	if (scope === "user" || scope === "all") sources.push([directories.userDir, "user"]);
	if (scope === "project" || scope === "all") sources.push([directories.projectDir, "project"]);
	const byName = new Map<string, AgentProfile>();
	for (const [dir, source] of sources) {
		if (dir) for (const profile of loadProfiles(dir, source)) byName.set(profile.name, profile);
	}
	return [...byName.values()];
}
