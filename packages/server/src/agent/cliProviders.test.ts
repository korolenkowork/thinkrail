import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CliProviderDraft } from "@thinkrail/contracts";
import {
	listCliProviders,
	removeCliProvider,
	saveCliProvider,
	testCliProvider,
} from "./cliProviders";
import { registerCliProviders } from "./cliProvidersFile";
import { setModelsFilePublisher } from "./modelsFile";
import { configurePiRuntime, settledAvailableModels } from "./piRuntime";

const FAKE_CLI = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
	if (process.env.FAKE_FAIL) {
		process.stderr.write("not signed in\\n");
		process.exit(2);
	}
	process.stdout.write(input.includes("just the word OK") ? "OK" : "hello");
});
`;

let directory: string;
let script: string;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-cli-providers-"));
	script = join(directory, "fake-cli.mjs");
	writeFileSync(script, FAKE_CLI);
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.PI_OFFLINE = "1";
});

afterEach(() => {
	setModelsFilePublisher(null);
	configurePiRuntime(null);
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	rmSync(directory, { recursive: true, force: true });
});

async function runtime() {
	const result = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		allowModelNetwork: false,
	});
	await result.refresh({ allowNetwork: false });
	configurePiRuntime(result);
	return result;
}

function draft(overrides: Partial<CliProviderDraft> = {}): CliProviderDraft {
	return {
		name: "Fake Tool",
		command: process.execPath,
		args: [script],
		prompt: "stdin",
		output: "text",
		jsonl: null,
		tools: "prompted",
		env: {},
		models: [{ id: "m1", name: "Model One", contextWindow: 200_000, maxTokens: null }],
		...overrides,
	};
}

function savedFile(): { providers: Array<Record<string, unknown>> } {
	return JSON.parse(readFileSync(join(directory, "cli-providers.json"), "utf8"));
}

test("saving a new tool writes cli-providers.json and registers it in the runtime", async () => {
	const rt = await runtime();
	let published = 0;
	setModelsFilePublisher(() => published++);
	const saved = await saveCliProvider(draft());
	expect(saved.map((provider) => provider.id)).toEqual(["cli-fake-tool"]);
	expect(saved[0]?.models).toEqual([
		{ id: "m1", name: "Model One", contextWindow: 200_000, maxTokens: null },
	]);
	expect(savedFile().providers[0]).toMatchObject({
		id: "cli-fake-tool",
		command: process.execPath,
		models: [{ id: "m1", name: "Model One", contextWindow: 200_000 }],
	});
	expect(savedFile().providers[0]?.env).toBeUndefined();
	expect(rt.getRegisteredProviderIds()).toContain("cli-fake-tool");
	expect(
		settledAvailableModels(rt)
			.filter((model) => model.provider === "cli-fake-tool")
			.map((model) => model.id),
	).toEqual(["m1"]);
	expect(published).toBe(1);
	expect(await listCliProviders()).toEqual(saved);
});

test("editing keeps the id and unknown fields; removing unregisters", async () => {
	const rt = await runtime();
	writeFileSync(
		join(directory, "cli-providers.json"),
		JSON.stringify({
			providers: [
				{ id: "gemini-cli", command: "gemini", note: "mine", models: [{ id: "gemini-2.5-pro" }] },
			],
		}),
	);
	const [listed] = await listCliProviders();
	expect(listed).toMatchObject({ id: "gemini-cli", name: "gemini-cli", prompt: "stdin" });
	await saveCliProvider({ ...draft({ name: "Gemini" }), id: "gemini-cli" });
	expect(savedFile().providers[0]).toMatchObject({
		id: "gemini-cli",
		name: "Gemini",
		note: "mine",
	});
	expect(rt.getRegisteredProviderIds()).toContain("gemini-cli");
	expect(await removeCliProvider("gemini-cli")).toEqual([]);
	expect(rt.getRegisteredProviderIds()).not.toContain("gemini-cli");
});

test("new ids never collide with existing ones", async () => {
	await runtime();
	await saveCliProvider(draft());
	const saved = await saveCliProvider(draft());
	expect(saved.map((provider) => provider.id)).toEqual(["cli-fake-tool", "cli-fake-tool-2"]);
});

test("rejects drafts the extension could not run", async () => {
	await runtime();
	await expect(saveCliProvider(draft({ name: " " }))).rejects.toThrow("Name the tool.");
	await expect(saveCliProvider(draft({ models: [] }))).rejects.toThrow("Add at least one model.");
	await expect(saveCliProvider(draft({ prompt: "arg" }))).rejects.toThrow("{prompt}");
	await expect(saveCliProvider(draft({ output: "jsonl" }))).rejects.toThrow("reply text");
	await expect(
		saveCliProvider(
			draft({
				models: [
					{ id: "a", name: "", contextWindow: null, maxTokens: null },
					{ id: "a", name: "", contextWindow: null, maxTokens: null },
				],
			}),
		),
	).rejects.toThrow("unique");
});

test("keeps jsonl selectors and drops empty matches", async () => {
	await runtime();
	await saveCliProvider(
		draft({
			output: "jsonl",
			jsonl: {
				text: { match: { type: "message" }, path: "content" },
				usage: { match: {}, input: "stats.in", output: "", total: "" },
				error: null,
			},
		}),
	);
	expect(savedFile().providers[0]?.jsonl).toEqual({
		text: { match: { type: "message" }, path: "content" },
		usage: { input: "stats.in" },
	});
});

test("registers saved tools when a runtime is built", async () => {
	writeFileSync(
		join(directory, "cli-providers.json"),
		JSON.stringify({ providers: [{ id: "cli-a", command: "a", models: [{ id: "m" }] }] }),
	);
	const rt = await runtime();
	registerCliProviders(rt);
	expect(rt.getRegisteredProviderIds()).toContain("cli-a");
});

test("test runs the command once and reports its reply or failure", async () => {
	expect(await testCliProvider({ draft: draft(), modelId: "m1" })).toEqual({
		ok: true,
		reply: "OK",
	});
	const failed = await testCliProvider({
		draft: draft({ env: { FAKE_FAIL: "1" } }),
		modelId: "m1",
	});
	expect(failed.ok).toBe(false);
	expect(!failed.ok && failed.error).toContain("not signed in");
	expect(await testCliProvider({ draft: draft(), modelId: "nope" })).toEqual({
		ok: false,
		error: "Pick one of this tool's models to test.",
	});
});
