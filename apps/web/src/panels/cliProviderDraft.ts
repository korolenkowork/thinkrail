import type { CliProvider, CliProviderDraft, CliProviderMatch } from "@thinkrail/contracts";

export interface CliModelRow {
	key: number;
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
}

export interface CliDraft {
	id?: string;
	name: string;
	command: string;
	args: string;
	prompt: "stdin" | "arg";
	output: "text" | "jsonl";
	textMatch: string;
	textPath: string;
	usageMatch: string;
	usageInput: string;
	usageOutput: string;
	usageTotal: string;
	errorMatch: string;
	errorPath: string;
	tools: "prompted" | "none";
	env: string;
	models: CliModelRow[];
}

let nextKey = 1;

function row(id = "", name = "", contextWindow = "", maxTokens = ""): CliModelRow {
	return { key: nextKey++, id, name, contextWindow, maxTokens };
}

export function formatMatch(match: CliProviderMatch): string {
	return Object.entries(match)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(", ");
}

export function parseMatch(source: string): CliProviderMatch {
	const match: CliProviderMatch = {};
	for (const part of source.split(",")) {
		const at = part.indexOf("=");
		if (at <= 0) continue;
		const key = part.slice(0, at).trim();
		if (key) match[key] = part.slice(at + 1).trim();
	}
	return match;
}

export function formatEnv(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

export function parseEnv(source: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of source.split("\n")) {
		const at = line.indexOf("=");
		if (at <= 0) continue;
		const key = line.slice(0, at).trim();
		if (key) env[key] = line.slice(at + 1);
	}
	return env;
}

function lines(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function count(source: string): number | null {
	const value = Number(source.trim());
	return source.trim() && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isCountText(source: string): boolean {
	return source.trim() === "" || count(source) !== null;
}

export function newCliDraft(): CliDraft {
	return {
		name: "",
		command: "",
		args: "",
		prompt: "stdin",
		output: "text",
		textMatch: "",
		textPath: "",
		usageMatch: "",
		usageInput: "",
		usageOutput: "",
		usageTotal: "",
		errorMatch: "",
		errorPath: "",
		tools: "prompted",
		env: "",
		models: [row()],
	};
}

export function geminiCliDraft(current: CliDraft): CliDraft {
	return {
		...current,
		name: current.name || "Gemini CLI",
		command: current.command || "gemini",
		args: "--model\n{model}\n--output-format\nstream-json",
		prompt: "stdin",
		output: "jsonl",
		textMatch: "type=message, role=assistant",
		textPath: "content",
		usageMatch: "type=result",
		usageInput: "stats.input_tokens",
		usageOutput: "stats.output_tokens",
		usageTotal: "stats.total_tokens",
		errorMatch: "type=error",
		errorPath: "message",
		models: [
			row("gemini-2.5-pro", "Gemini 2.5 Pro (CLI)", "1048576", "65536"),
			row("gemini-2.5-flash", "Gemini 2.5 Flash (CLI)", "1048576", "65536"),
		],
	};
}

export function editCliDraft(provider: CliProvider): CliDraft {
	const { jsonl } = provider;
	return {
		id: provider.id,
		name: provider.name,
		command: provider.command,
		args: provider.args.join("\n"),
		prompt: provider.prompt,
		output: provider.output,
		textMatch: jsonl ? formatMatch(jsonl.text.match) : "",
		textPath: jsonl?.text.path ?? "",
		usageMatch: jsonl?.usage ? formatMatch(jsonl.usage.match) : "",
		usageInput: jsonl?.usage?.input ?? "",
		usageOutput: jsonl?.usage?.output ?? "",
		usageTotal: jsonl?.usage?.total ?? "",
		errorMatch: jsonl?.error ? formatMatch(jsonl.error.match) : "",
		errorPath: jsonl?.error?.path ?? "",
		tools: provider.tools,
		env: formatEnv(provider.env),
		models: provider.models.map((model) =>
			row(
				model.id,
				model.name === model.id ? "" : model.name,
				model.contextWindow === null ? "" : String(model.contextWindow),
				model.maxTokens === null ? "" : String(model.maxTokens),
			),
		),
	};
}

export function addModelRow(draft: CliDraft): CliDraft {
	return { ...draft, models: [...draft.models, row()] };
}

export function updateModelRow(
	draft: CliDraft,
	key: number,
	patch: Partial<CliModelRow>,
): CliDraft {
	return {
		...draft,
		models: draft.models.map((model) => (model.key === key ? { ...model, ...patch } : model)),
	};
}

export function removeModelRow(draft: CliDraft, key: number): CliDraft {
	return { ...draft, models: draft.models.filter((model) => model.key !== key) };
}

export function filledModels(draft: CliDraft): CliModelRow[] {
	return draft.models.filter((model) => model.id.trim());
}

export function canSaveCliDraft(draft: CliDraft): boolean {
	const models = filledModels(draft);
	const ids = new Set(models.map((model) => model.id.trim()));
	return (
		draft.name.trim() !== "" &&
		draft.command.trim() !== "" &&
		models.length > 0 &&
		ids.size === models.length &&
		models.every((model) => isCountText(model.contextWindow) && isCountText(model.maxTokens)) &&
		(draft.prompt === "stdin" || draft.args.includes("{prompt}")) &&
		(draft.output === "text" || draft.textPath.trim() !== "")
	);
}

export function cliDraftParams(draft: CliDraft): CliProviderDraft {
	const usage =
		draft.usageInput.trim() || draft.usageOutput.trim() || draft.usageTotal.trim()
			? {
					match: parseMatch(draft.usageMatch),
					input: draft.usageInput.trim(),
					output: draft.usageOutput.trim(),
					total: draft.usageTotal.trim(),
				}
			: null;
	const error = draft.errorPath.trim()
		? { match: parseMatch(draft.errorMatch), path: draft.errorPath.trim() }
		: null;
	return {
		...(draft.id === undefined ? {} : { id: draft.id }),
		name: draft.name.trim(),
		command: draft.command.trim(),
		args: lines(draft.args),
		prompt: draft.prompt,
		output: draft.output,
		jsonl:
			draft.output === "jsonl"
				? {
						text: { match: parseMatch(draft.textMatch), path: draft.textPath.trim() },
						usage,
						error,
					}
				: null,
		tools: draft.tools,
		env: parseEnv(draft.env),
		models: filledModels(draft).map((model) => ({
			id: model.id.trim(),
			name: model.name.trim() || model.id.trim(),
			contextWindow: count(model.contextWindow),
			maxTokens: count(model.maxTokens),
		})),
	};
}
