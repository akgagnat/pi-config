import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type SubagentLimits = {
	maxConcurrent: number;
	defaultTimeoutMs: number;
	outputMaxBytes: number;
	outputMaxLines: number;
	logMaxChars: number;
	completedJobRetention: number;
	journalMaxEvents: number;
	journalRetention: number;
	journalMaxAgeMs: number;
};

export const DEFAULT_SUBAGENT_LIMITS: Readonly<SubagentLimits> = {
	maxConcurrent: 4,
	defaultTimeoutMs: 15 * 60_000,
	outputMaxBytes: 20_000,
	outputMaxLines: 600,
	logMaxChars: 40_000,
	completedJobRetention: 20,
	journalMaxEvents: 500,
	journalRetention: 100,
	journalMaxAgeMs: 30 * 24 * 60 * 60_000,
};

const SETTING_BOUNDS = {
	maxConcurrent: { min: 1, max: 16 },
	defaultTimeoutMs: { min: 1_000, max: 2 * 60 * 60_000 },
	outputMaxBytes: { min: 1_024, max: 1_000_000 },
	outputMaxLines: { min: 1, max: 10_000 },
	logMaxChars: { min: 1_024, max: 1_000_000 },
	completedJobRetention: { min: 1, max: 100 },
	journalMaxEvents: { min: 1, max: 2_000 },
	journalRetention: { min: 1, max: 1_000 },
	journalMaxAgeMs: { min: 60_000, max: 365 * 24 * 60 * 60_000 },
} as const;

type SubagentSettingName = keyof SubagentLimits;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSetting(name: string, detail: string): Error {
	return new Error(`Invalid subagents.${name} setting: ${detail}`);
}

function parseBoundedInteger(name: SubagentSettingName, value: unknown): number {
	const bounds = SETTING_BOUNDS[name];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidSetting(name, "must be an integer.");
	if (value < bounds.min || value > bounds.max) {
		throw invalidSetting(name, `must be between ${bounds.min} and ${bounds.max}.`);
	}
	return value;
}

/** Parse the small, global `subagents` block without accepting unknown knobs. */
export function parseSubagentLimits(value: unknown): SubagentLimits {
	if (value === undefined) return { ...DEFAULT_SUBAGENT_LIMITS };
	if (!isRecord(value)) throw new Error("Invalid subagents setting: must be an object.");
	const limits = { ...DEFAULT_SUBAGENT_LIMITS };
	for (const [name, setting] of Object.entries(value)) {
		if (!(name in SETTING_BOUNDS)) throw invalidSetting(name, "is not supported.");
		const key = name as SubagentSettingName;
		limits[key] = parseBoundedInteger(key, setting);
	}
	return limits;
}

/**
 * Read global Pi settings. Pi preserves extension-owned settings keys, but does
 * not expose the effective settings manager through ExtensionContext.
 */
export function loadSubagentLimits(cwd: string): SubagentLimits {
	const settings = SettingsManager.create(cwd).getGlobalSettings() as Record<string, unknown>;
	return parseSubagentLimits(settings.subagents);
}

export function resolveTimeoutMs(requestedTimeoutMs: number | undefined, limits: SubagentLimits): number {
	if (requestedTimeoutMs === undefined) return limits.defaultTimeoutMs;
	const bounds = SETTING_BOUNDS.defaultTimeoutMs;
	if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < bounds.min || requestedTimeoutMs > bounds.max) {
		throw new Error(`Invalid timeoutMs: must be an integer between ${bounds.min} and ${bounds.max}.`);
	}
	return requestedTimeoutMs;
}
