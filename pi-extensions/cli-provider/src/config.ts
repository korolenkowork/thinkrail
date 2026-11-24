import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CliMatch = Record<string, string | number | boolean>;

export interface CliModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface CliProviderConfig {
	id: string;
	name?: string;
	command: string;
	args?: string[];
	prompt?: "stdin" | "arg";
	output?: "text" | "jsonl";
	jsonl?: {
		text: { match?: CliMatch; path: string };
		usage?: { match?: CliMatch; input?: string; output?: string; total?: string };
		error?: { match?: CliMatch; path: string };
	};
	tools?: "prompted" | "none";
	env?: Record<string, string>;
	models: CliModelConfig[];
}

export const CONFIG_FILE = "cli-providers.json";

export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

export function loadCliProviders(path = configPath()): CliProviderConfig[] {
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { providers?: CliProviderConfig[] };
	const providers = parsed.providers ?? [];
	for (const provider of providers) validateProvider(provider);
	return providers;
}

export function validateProvider(provider: CliProviderConfig): void {
	if (!provider.id || !provider.command || !provider.models?.length) {
		throw new Error(`${CONFIG_FILE}: every provider needs "id", "command" and at least one model`);
	}
	if (provider.output === "jsonl" && !provider.jsonl?.text?.path) {
		throw new Error(
			`${CONFIG_FILE}: provider "${provider.id}" uses jsonl output but has no jsonl.text.path`,
		);
	}
}
