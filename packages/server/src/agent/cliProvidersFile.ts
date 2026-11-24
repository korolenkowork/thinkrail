import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type CliProviderConfig,
	cliProviderRegistration,
	configPath,
} from "@thinkrail/pi-cli-provider";
import { logger } from "../log";

const log = logger("agent");

const READ_FAILURE = "Couldn't read pi's cli-providers.json. Fix the file and retry.";
const SAVE_FAILURE =
	"Couldn't save pi's cli-providers.json. Check the file and its permissions, then retry.";

export type Json = Record<string, unknown>;

const registered = new WeakMap<ModelRuntime, Set<string>>();

export function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readEntries(): Json[] {
	let source: string;
	try {
		source = readFileSync(configPath(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw new Error(READ_FAILURE);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error("Pi's cli-providers.json isn't valid JSON. Fix the file and retry.");
	}
	const providers = isObject(parsed) ? parsed.providers : undefined;
	return Array.isArray(providers) ? providers.filter(isObject) : [];
}

export function writeEntries(entries: readonly Json[]): void {
	const target = configPath();
	const temp = join(dirname(target), `.cli-providers.json.${process.pid}.tmp`);
	try {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(temp, `${JSON.stringify({ providers: entries }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, target);
	} catch {
		rmSync(temp, { force: true });
		throw new Error(SAVE_FAILURE);
	}
}

export function registerCliProviders(runtime: ModelRuntime): void {
	const previous = registered.get(runtime) ?? new Set<string>();
	for (const id of previous) runtime.unregisterProvider(id);
	const ids = new Set<string>();
	let failures = 0;
	let entries: Json[] = [];
	try {
		entries = readEntries();
	} catch {
		failures += 1;
	}
	for (const entry of entries) {
		try {
			const config = entry as unknown as CliProviderConfig;
			runtime.registerProvider(config.id, cliProviderRegistration(config));
			ids.add(config.id);
		} catch {
			failures += 1;
		}
	}
	registered.set(runtime, ids);
	if (failures > 0) log.warn(`cli providers: ${failures} entry or file failure(s) skipped`);
}
