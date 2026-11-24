import { describe, expect, test } from "bun:test";
import type { CliProvider } from "@thinkrail/contracts";
import {
	addModelRow,
	canSaveCliDraft,
	cliDraftParams,
	editCliDraft,
	geminiCliDraft,
	newCliDraft,
	parseEnv,
	parseMatch,
	removeModelRow,
	updateModelRow,
} from "./cliProviderDraft";

const gemini: CliProvider = {
	id: "gemini-cli",
	name: "Gemini CLI",
	command: "gemini",
	args: ["--model", "{model}"],
	prompt: "stdin",
	output: "jsonl",
	jsonl: {
		text: { match: { type: "message", role: "assistant" }, path: "content" },
		usage: { match: { type: "result" }, input: "stats.in", output: "stats.out", total: "" },
		error: null,
	},
	tools: "prompted",
	env: { HOME_HINT: "a=b" },
	models: [
		{ id: "gemini-2.5-pro", name: "gemini-2.5-pro", contextWindow: 1_048_576, maxTokens: null },
	],
};

describe("cli provider draft", () => {
	test("a new draft cannot be saved until it names a command and a model", () => {
		const draft = newCliDraft();
		expect(canSaveCliDraft(draft)).toBe(false);
		const [row] = draft.models;
		if (!row) throw new Error("expected a model row");
		const filled = updateModelRow({ ...draft, name: "Tool", command: "/bin/tool" }, row.key, {
			id: "m",
		});
		expect(canSaveCliDraft(filled)).toBe(true);
		expect(canSaveCliDraft({ ...filled, prompt: "arg" })).toBe(false);
		expect(canSaveCliDraft({ ...filled, prompt: "arg", args: "-p\n{prompt}" })).toBe(true);
		expect(canSaveCliDraft({ ...filled, output: "jsonl" })).toBe(false);
		expect(canSaveCliDraft(updateModelRow(filled, row.key, { contextWindow: "lots" }))).toBe(false);
	});

	test("editing round-trips a saved provider", () => {
		expect(cliDraftParams(editCliDraft(gemini))).toEqual(gemini);
	});

	test("the Gemini preset fills a runnable jsonl setup", () => {
		const draft = geminiCliDraft(newCliDraft());
		expect(canSaveCliDraft(draft)).toBe(true);
		const params = cliDraftParams(draft);
		expect(params.args).toEqual(["--model", "{model}", "--output-format", "stream-json"]);
		expect(params.jsonl?.text).toEqual({
			match: { type: "message", role: "assistant" },
			path: "content",
		});
		expect(params.jsonl?.error).toEqual({ match: { type: "error" }, path: "message" });
		expect(params.models.map((model) => model.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
	});

	test("blank model rows are dropped and rows can be added and removed", () => {
		const draft = addModelRow(geminiCliDraft(newCliDraft()));
		expect(cliDraftParams(draft).models).toHaveLength(2);
		const last = draft.models.at(-1);
		if (!last) throw new Error("expected a row");
		expect(removeModelRow(draft, last.key).models).toHaveLength(2);
	});

	test("parses key=value matches and environment lines", () => {
		expect(parseMatch("type = message, role=assistant, junk")).toEqual({
			type: "message",
			role: "assistant",
		});
		expect(parseEnv("A=1\nB=x=y\n\n=skip")).toEqual({ A: "1", B: "x=y" });
	});
});
