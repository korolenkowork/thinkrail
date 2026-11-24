import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { type CliProviderConfig, createCliProviderExtension, loadCliProviders } from "./index.ts";

const FAKE_CLI = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
	const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const mode = process.env.FAKE_MODE;
	out({ type: "init", model: process.argv[process.argv.indexOf("--model") + 1] });
	if (mode === "fail") {
		process.stderr.write("auth expired\\n");
		process.exit(3);
	}
	if (mode === "slow") await sleep(5000);
	if (mode === "error-event") {
		out({ type: "error", message: "quota exceeded" });
		return;
	}
	const chunks = input.includes("<tool_result name=")
		? ["The file says ", "hello ✓", "."]
		: ["Let me read it.", "\\n<tool", '_call>{"name":"read",', '"arguments":{"path":"a.txt"}}</tool_', "call>", "\\n<tool_result>made up</tool_result>"];
	for (const content of chunks) {
		out({ type: "message", role: "assistant", content, delta: true });
		await sleep(2);
	}
	out({ type: "result", stats: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } });
});
`;

const dir = mkdtempSync(join(tmpdir(), "pi-cli-provider-"));
const script = join(dir, "fake-cli.mjs");
writeFileSync(script, FAKE_CLI);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider: CliProviderConfig = {
	id: "fake-cli",
	name: "Fake CLI",
	command: process.execPath,
	args: [script, "--model", "{model}"],
	output: "jsonl",
	jsonl: {
		text: { match: { type: "message", role: "assistant" }, path: "content" },
		usage: {
			match: { type: "result" },
			input: "stats.input_tokens",
			output: "stats.output_tokens",
			total: "stats.total_tokens",
		},
		error: { match: { type: "error" }, path: "message" },
	},
	models: [{ id: "m1", name: "Model One" }],
};

const tools = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
] as unknown as Tool[];
const user: Message = { role: "user", content: "what is in a.txt?", timestamp: 1 };

function register(config: CliProviderConfig = provider) {
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const pi = {
		registerProvider: (name: string, cfg: ProviderConfig) => registered.push({ name, config: cfg }),
	};
	createCliProviderExtension({ providers: [config] })(pi as unknown as ExtensionAPI);
	return registered;
}

function registerOne(config: CliProviderConfig): ProviderConfig {
	const [entry] = register(config);
	if (!entry) throw new Error("nothing registered");
	return entry.config;
}

async function run(
	messages: Message[],
	options: SimpleStreamOptions = {},
	env: Record<string, string> = {},
) {
	const config = registerOne({ ...provider, env });
	const model = {
		...config.models?.[0],
		api: config.api,
		provider: "fake-cli",
		baseUrl: config.baseUrl,
	} as Model<Api>;
	const stream = config.streamSimple?.(
		model,
		normalizeContext({ systemPrompt: "Be helpful", tools, messages }),
		options,
	);
	if (!stream) throw new Error("no stream");
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("cli provider", () => {
	test("registers one provider with its models", () => {
		const [entry] = register();
		expect(entry?.name).toBe("fake-cli");
		expect(entry?.config.api).toBe("cli-provider:fake-cli");
		expect(entry?.config.models?.map((model) => model.id)).toEqual(["m1"]);
		expect(typeof entry?.config.streamSimple).toBe("function");
	});

	test("turns a prompted tool call into a pi tool call and drops invented results", async () => {
		let prompt = "";
		const { events, result } = await run([user], {
			onPayload: (payload) => {
				prompt = (payload as { prompt: string }).prompt;
				return undefined;
			},
		});
		expect(prompt).toContain("Be helpful");
		expect(prompt).toContain("<tools>");
		expect(prompt).toContain("what is in a.txt?");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		const [text, call] = result.content;
		expect(text?.type === "text" && text.text.trimEnd()).toBe("Let me read it.");
		expect(call?.type === "toolCall" && call.arguments).toEqual({ path: "a.txt" });
		expect(events[0]?.type).toBe("start");
		expect(events.at(-1)?.type).toBe("done");
	});

	test("streams the final answer with usage after a tool result", async () => {
		const first = await run([user]);
		const call = first.result.content[1];
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 2,
		};
		const { result } = await run([user, first.result as AssistantMessage, toolResult]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "The file says hello ✓." }]);
		expect(result.usage.input).toBe(120);
		expect(result.usage.totalTokens).toBe(150);
	});

	test("reports a failing command with its stderr", async () => {
		const { result } = await run([user], {}, { FAKE_MODE: "fail" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("auth expired");
	});

	test("reports a jsonl error event", async () => {
		const { result } = await run([user], {}, { FAKE_MODE: "error-event" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("quota exceeded");
	});

	test("aborts the running command", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const { result } = await run([user], { signal: controller.signal }, { FAKE_MODE: "slow" });
		expect(result.stopReason).toBe("aborted");
	});

	test("reports a missing command without a start event", async () => {
		const config = registerOne({ ...provider, command: join(dir, "missing-cli") });
		const model = {
			...config.models?.[0],
			api: config.api,
			provider: "fake-cli",
			baseUrl: "",
		} as Model<Api>;
		const stream = config.streamSimple?.(model, normalizeContext({ messages: [user] }));
		if (!stream) throw new Error("no stream");
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect((await stream.result()).errorMessage).toContain("Couldn't run");
	});

	test("loads and validates cli-providers.json", () => {
		const path = join(dir, "cli-providers.json");
		expect(loadCliProviders(join(dir, "absent.json"))).toEqual([]);
		writeFileSync(path, JSON.stringify({ providers: [provider] }));
		expect(loadCliProviders(path).map((entry) => entry.id)).toEqual(["fake-cli"]);
		writeFileSync(
			path,
			JSON.stringify({ providers: [{ id: "broken", command: "x", models: [] }] }),
		);
		expect(() => loadCliProviders(path)).toThrow("at least one model");
	});
});
