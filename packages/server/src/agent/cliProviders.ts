import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import {
	CLI_PROVIDER_ID_PREFIX,
	type CliProvider,
	type CliProviderDraft,
	type CliProviderMatch,
	type CliProviderTest,
	type CliProviderTestRequest,
} from "@thinkrail/contracts";
import {
	type CliProviderConfig,
	cliProviderRegistration,
	streamCli,
} from "@thinkrail/pi-cli-provider";
import { logger } from "../log";
import { usePiRuntime } from "./agentSessionManager";
import {
	isObject,
	type Json,
	readEntries,
	registerCliProviders,
	writeEntries,
} from "./cliProvidersFile";
import { publishModelsFileChange } from "./modelsFile";

const log = logger("agent");

const MAX_MODELS = 100;
const TEST_TIMEOUT_MS = 60_000;
const TEST_REPLY_LIMIT = 2_000;
const TEST_PROMPT = "Reply with just the word OK.";
let writes: Promise<unknown> = Promise.resolve();

function positiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function match(value: unknown): CliProviderMatch {
	const result: CliProviderMatch = {};
	if (!isObject(value)) return result;
	for (const [key, entry] of Object.entries(value))
		if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
			result[key] = entry;
	return result;
}

function toWire(entry: Json): CliProvider {
	const jsonl = isObject(entry.jsonl) ? entry.jsonl : undefined;
	const textSpec = isObject(jsonl?.text) ? jsonl.text : undefined;
	const usage = isObject(jsonl?.usage) ? jsonl.usage : undefined;
	const error = isObject(jsonl?.error) ? jsonl.error : undefined;
	const env: Record<string, string> = {};
	if (isObject(entry.env))
		for (const [key, value] of Object.entries(entry.env))
			if (typeof value === "string") env[key] = value;
	return {
		id: text(entry.id),
		name: text(entry.name, text(entry.id)),
		command: text(entry.command),
		args: Array.isArray(entry.args)
			? entry.args.filter((arg): arg is string => typeof arg === "string")
			: [],
		prompt: entry.prompt === "arg" ? "arg" : "stdin",
		output: entry.output === "jsonl" ? "jsonl" : "text",
		jsonl: textSpec
			? {
					text: { match: match(textSpec.match), path: text(textSpec.path) },
					usage: usage
						? {
								match: match(usage.match),
								input: text(usage.input),
								output: text(usage.output),
								total: text(usage.total),
							}
						: null,
					error: error ? { match: match(error.match), path: text(error.path) } : null,
				}
			: null,
		tools: entry.tools === "none" ? "none" : "prompted",
		env,
		models: (Array.isArray(entry.models) ? entry.models : []).filter(isObject).map((model) => ({
			id: text(model.id),
			name: text(model.name, text(model.id)),
			contextWindow: positiveInt(model.contextWindow),
			maxTokens: positiveInt(model.maxTokens),
		})),
	};
}

function withoutEmpty(spec: CliProviderMatch): CliProviderMatch | undefined {
	return Object.keys(spec).length > 0 ? spec : undefined;
}

function toConfig(
	draft: CliProviderDraft,
	id: string,
	previous: Json | undefined,
): CliProviderConfig {
	const config: Json = {
		...(previous ?? {}),
		id,
		name: draft.name.trim(),
		command: draft.command.trim(),
		args: draft.args,
		prompt: draft.prompt,
		output: draft.output,
		tools: draft.tools,
		models: draft.models.map((model) => {
			const entry: Json = { id: model.id.trim(), name: model.name.trim() || model.id.trim() };
			if (model.contextWindow !== null) entry.contextWindow = model.contextWindow;
			if (model.maxTokens !== null) entry.maxTokens = model.maxTokens;
			return entry;
		}),
	};
	if (Object.keys(draft.env).length > 0) config.env = draft.env;
	else delete config.env;
	if (draft.output === "jsonl" && draft.jsonl) {
		const { text: textSpec, usage, error } = draft.jsonl;
		config.jsonl = {
			text: { match: withoutEmpty(textSpec.match), path: textSpec.path.trim() },
			...(usage
				? {
						usage: {
							match: withoutEmpty(usage.match),
							...(usage.input.trim() ? { input: usage.input.trim() } : {}),
							...(usage.output.trim() ? { output: usage.output.trim() } : {}),
							...(usage.total.trim() ? { total: usage.total.trim() } : {}),
						},
					}
				: {}),
			...(error ? { error: { match: withoutEmpty(error.match), path: error.path.trim() } } : {}),
		};
	} else delete config.jsonl;
	return config as unknown as CliProviderConfig;
}

function isCount(value: unknown): boolean {
	return value === null || positiveInt(value) !== null;
}

function validateDraft(draft: CliProviderDraft): void {
	if (!isObject(draft) || typeof draft.name !== "string" || typeof draft.command !== "string")
		throw new Error("Name and command must be text.");
	if (!draft.name.trim()) throw new Error("Name the tool.");
	if (!draft.command.trim()) throw new Error("Enter the command to run.");
	if (!Array.isArray(draft.args) || draft.args.some((arg) => typeof arg !== "string"))
		throw new Error("Arguments must be text.");
	if (draft.prompt !== "stdin" && draft.prompt !== "arg")
		throw new Error("Choose how the prompt is sent.");
	if (draft.prompt === "arg" && !draft.args.some((arg) => arg.includes("{prompt}")))
		throw new Error("Add {prompt} to the arguments, or send the prompt on standard input.");
	if (draft.output !== "text" && draft.output !== "jsonl")
		throw new Error("Choose how the reply is read.");
	if (draft.output === "jsonl" && !draft.jsonl?.text.path.trim())
		throw new Error("Enter the field that holds the reply text.");
	if (draft.tools !== "prompted" && draft.tools !== "none")
		throw new Error("Choose whether pi's tools are offered.");
	if (!isObject(draft.env) || Object.values(draft.env).some((value) => typeof value !== "string"))
		throw new Error("Environment values must be text.");
	if (!Array.isArray(draft.models) || draft.models.length === 0)
		throw new Error("Add at least one model.");
	if (draft.models.length > MAX_MODELS) throw new Error("Add fewer models.");
	const ids = new Set<string>();
	for (const model of draft.models) {
		const id = isObject(model) && typeof model.id === "string" ? model.id.trim() : "";
		if (!id || ids.has(id)) throw new Error("Model ids must be unique and non-empty.");
		ids.add(id);
		if (typeof model.name !== "string") throw new Error("Model names must be text.");
		if (!isCount(model.contextWindow) || !isCount(model.maxTokens))
			throw new Error("Model limits must be whole numbers.");
	}
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function newId(name: string, taken: ReadonlySet<string>): string {
	const base = `${CLI_PROVIDER_ID_PREFIX}${slug(name) || "tool"}`;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

async function apply(edit: (entries: Json[]) => Json[] | null): Promise<CliProvider[]> {
	return usePiRuntime(async (runtime) => {
		const entries = readEntries();
		const edited = edit(entries);
		if (edited === null) return entries.map(toWire);
		writeEntries(edited);
		registerCliProviders(runtime);
		try {
			await runtime.refresh({ allowNetwork: false });
		} catch (error) {
			log.warn("pi runtime refresh after a cli provider save failed", error);
		}
		publishModelsFileChange();
		return edited.map(toWire);
	});
}

function commit(edit: (entries: Json[]) => Json[] | null): Promise<CliProvider[]> {
	const next = writes.catch(() => undefined).then(() => apply(edit));
	writes = next;
	return next;
}

export function listCliProviders(): Promise<CliProvider[]> {
	return Promise.resolve().then(() => readEntries().map(toWire));
}

export function saveCliProvider(draft: CliProviderDraft): Promise<CliProvider[]> {
	try {
		validateDraft(draft);
	} catch (error) {
		return Promise.reject(error);
	}
	return commit((entries) => {
		const index = draft.id === undefined ? -1 : entries.findIndex((entry) => entry.id === draft.id);
		if (draft.id !== undefined && index < 0)
			throw new Error("That tool is no longer in cli-providers.json. Reload and retry.");
		const taken = new Set(entries.map((entry) => text(entry.id)));
		const id = draft.id ?? newId(draft.name, taken);
		const value = toConfig(draft, id, index < 0 ? undefined : entries[index]);
		cliProviderRegistration(value);
		const next = [...entries];
		if (index < 0) next.push(value as unknown as Json);
		else next[index] = value as unknown as Json;
		return next;
	});
}

export function removeCliProvider(id: string): Promise<CliProvider[]> {
	return commit((entries) => {
		const next = entries.filter((entry) => entry.id !== id);
		return next.length === entries.length ? null : next;
	});
}

export async function testCliProvider(request: CliProviderTestRequest): Promise<CliProviderTest> {
	validateDraft(request.draft);
	const id = request.draft.id ?? `${CLI_PROVIDER_ID_PREFIX}test`;
	const config = { ...toConfig(request.draft, id, undefined), tools: "none" as const };
	const registration = cliProviderRegistration(config);
	const model = registration.models?.find((entry) => entry.id === request.modelId);
	if (!model) return { ok: false, error: "Pick one of this tool's models to test." };
	const target = {
		...model,
		api: registration.api ?? "",
		provider: id,
		baseUrl: registration.baseUrl ?? "",
	} as Model<Api>;
	const stream = streamCli(
		config,
		target,
		normalizeContext({ messages: [{ role: "user", content: TEST_PROMPT, timestamp: Date.now() }] }),
		{ signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
	);
	const result = await stream.result();
	if (result.stopReason === "aborted")
		return { ok: false, error: `No reply within ${TEST_TIMEOUT_MS / 1000} seconds.` };
	if (result.stopReason === "error")
		return { ok: false, error: result.errorMessage ?? "The command failed." };
	const reply = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("")
		.trim();
	if (!reply) return { ok: false, error: "The command finished without a reply." };
	return { ok: true, reply: reply.slice(0, TEST_REPLY_LIMIT) };
}
