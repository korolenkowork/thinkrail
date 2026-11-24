import { spawn } from "node:child_process";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	getCurrentTools,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CliMatch, CliProviderConfig } from "./config.ts";
import { RESULT_OPEN, renderPrompt, TOOL_CLOSE, TOOL_OPEN } from "./prompt.ts";

export interface CliPayload {
	command: string;
	args: string[];
	prompt: string;
}

const STDERR_TAIL = 4000;

export function streamCli(
	provider: CliProviderConfig,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const tools =
		(provider.tools ?? "prompted") === "prompted" ? getCurrentTools(context.messages) : [];

	const fail = (reason: "error" | "aborted", message: string): void => {
		output.stopReason = reason;
		output.errorMessage = message;
		stream.push({ type: "error", reason, error: output });
		stream.end();
	};

	void (async () => {
		let payload: CliPayload = {
			command: provider.command,
			args: (provider.args ?? []).map((arg) => arg.replaceAll("{model}", model.id)),
			prompt: renderPrompt(context, tools),
		};
		const replaced = await options?.onPayload?.(payload, model);
		if (replaced && typeof replaced === "object") payload = replaced as CliPayload;
		if (options?.signal?.aborted) return fail("aborted", "Request aborted");

		const viaArg = provider.prompt === "arg";
		const args = viaArg
			? payload.args.map((arg) => arg.replaceAll("{prompt}", payload.prompt))
			: payload.args;
		const child = spawn(payload.command, args, {
			env: { ...process.env, ...provider.env, ...options?.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let started = false;
		let finished = false;
		let aborted = false;
		let cliError: string | undefined;
		let stderr = "";
		const parser = createParser(output, stream, tools, () => child.kill("SIGTERM"));

		const onAbort = (): void => {
			aborted = true;
			child.kill("SIGTERM");
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("spawn", () => {
			started = true;
			stream.push({ type: "start", partial: output });
			void options?.onResponse?.({ status: 200, headers: {} }, model);
		});
		child.on("error", (error) => {
			if (finished) return;
			finished = true;
			options?.signal?.removeEventListener("abort", onAbort);
			fail("error", `Couldn't run "${payload.command}": ${error.message}`);
		});

		child.stdin.on("error", () => {});
		child.stdin.end(viaArg ? "" : payload.prompt);

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_TAIL);
		});

		const onLine = async (line: string): Promise<void> => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			await options?.onProviderStreamEvent?.(event, model);
			const spec = provider.jsonl;
			if (!spec) return;
			if (matches(event, spec.text.match)) {
				const text = readPath(event, spec.text.path);
				if (typeof text === "string") parser.feed(text);
			}
			if (spec.usage && matches(event, spec.usage.match)) {
				const input = toNumber(spec.usage.input && readPath(event, spec.usage.input));
				const out = toNumber(spec.usage.output && readPath(event, spec.usage.output));
				const total = toNumber(spec.usage.total && readPath(event, spec.usage.total));
				output.usage.input = input;
				output.usage.output = out;
				output.usage.totalTokens = total || input + out;
				output.usage.cost = calculateCost(model, output.usage);
			}
			if (spec.error && matches(event, spec.error.match)) {
				const message = readPath(event, spec.error.path);
				cliError = typeof message === "string" ? message : JSON.stringify(event);
			}
		};

		child.stdout.setEncoding("utf8");
		let lineBuffer = "";
		let queue = Promise.resolve();
		child.stdout.on("data", (chunk: string) => {
			if (provider.output !== "jsonl") {
				parser.feed(chunk);
				return;
			}
			lineBuffer += chunk;
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) queue = queue.then(() => onLine(line));
		});

		child.on("close", (code) => {
			void queue.then(async () => {
				if (lineBuffer) await onLine(lineBuffer);
				if (finished) return;
				finished = true;
				options?.signal?.removeEventListener("abort", onAbort);
				if (!started) return fail("error", `Couldn't run "${payload.command}"`);
				if (aborted) return fail("aborted", "Request aborted");
				parser.flush();
				if (cliError) return fail("error", cliError);
				if (code !== 0 && !parser.stoppedEarly()) {
					const detail = stderr.trim() || `exit code ${code}`;
					return fail("error", `"${payload.command}" failed: ${detail}`);
				}
				const reason = output.content.some((block) => block.type === "toolCall")
					? "toolUse"
					: "stop";
				output.stopReason = reason;
				stream.push({ type: "done", reason, message: output });
				stream.end();
			});
		});
	})().catch((error: unknown) => {
		fail("error", error instanceof Error ? error.message : String(error));
	});

	return stream;
}

function createParser(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	tools: readonly Tool[],
	stop: () => void,
) {
	let pending = "";
	let inTool = false;
	let textIndex = -1;
	let carry = "";
	let toolCalls = 0;
	let stopped = false;

	const endText = (): void => {
		if (textIndex < 0) return;
		const block = output.content[textIndex];
		if (block?.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: textIndex,
				content: block.text,
				partial: output,
			});
		}
		textIndex = -1;
	};

	const emitText = (text: string): void => {
		if (!text) return;
		if (textIndex < 0) {
			if (!text.trim()) {
				carry += text;
				return;
			}
			text = (output.content.length ? carry.trimStart() : carry) + text;
			carry = "";
			output.content.push({ type: "text", text: "" });
			textIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
		}
		const block = output.content[textIndex];
		if (block?.type !== "text") return;
		block.text += text;
		stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
	};

	const emitToolCall = (raw: string): boolean => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.trim());
		} catch {
			return false;
		}
		if (!parsed || typeof parsed !== "object") return false;
		const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown };
		if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) return false;
		endText();
		carry = "";
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `call_${Date.now().toString(36)}_${toolCalls}`,
			name,
			arguments:
				args && typeof args === "object" && !Array.isArray(args) ? (args as JsonObject) : {},
		};
		output.content.push(toolCall);
		const index = output.content.length - 1;
		stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
		stream.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: JSON.stringify(toolCall.arguments),
			partial: output,
		});
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
		toolCalls += 1;
		return true;
	};

	const markers = (): string[] => (toolCalls > 0 ? [TOOL_OPEN, RESULT_OPEN] : [TOOL_OPEN]);

	const drain = (final: boolean): void => {
		while (pending && !stopped) {
			if (inTool) {
				const close = pending.indexOf(TOOL_CLOSE);
				if (close < 0 && !final) return;
				const body = close < 0 ? pending : pending.slice(0, close);
				pending = close < 0 ? "" : pending.slice(close + TOOL_CLOSE.length);
				inTool = false;
				if (!emitToolCall(body)) emitText(TOOL_OPEN + body + (close < 0 ? "" : TOOL_CLOSE));
				continue;
			}
			if (tools.length === 0) {
				emitText(pending);
				pending = "";
				return;
			}
			const found = markers()
				.map((marker) => ({ marker, at: pending.indexOf(marker) }))
				.filter(({ at }) => at >= 0)
				.sort((a, b) => a.at - b.at)[0];
			if (found) {
				emitText(pending.slice(0, found.at));
				if (found.marker === RESULT_OPEN) {
					pending = "";
					stopped = true;
					stop();
					return;
				}
				pending = pending.slice(found.at + TOOL_OPEN.length);
				inTool = true;
				continue;
			}
			const hold = final ? 0 : heldBack(pending, markers());
			emitText(pending.slice(0, pending.length - hold));
			pending = pending.slice(pending.length - hold);
			return;
		}
	};

	return {
		feed(text: string): void {
			if (stopped) return;
			pending += text;
			drain(false);
		},
		flush(): void {
			drain(true);
			endText();
		},
		stoppedEarly: (): boolean => stopped,
	};
}

function heldBack(text: string, markers: readonly string[]): number {
	let hold = 0;
	for (const marker of markers) {
		for (let size = Math.min(marker.length - 1, text.length); size > hold; size--) {
			if (marker.startsWith(text.slice(-size))) {
				hold = size;
				break;
			}
		}
	}
	return hold;
}

function matches(event: unknown, match: CliMatch | undefined): boolean {
	if (!match) return true;
	if (!event || typeof event !== "object") return false;
	return Object.entries(match).every(([key, value]) => readPath(event, key) === value);
}

function readPath(value: unknown, path: string): unknown {
	let current = value;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
