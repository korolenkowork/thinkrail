import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	type Message,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export const TOOL_OPEN = "<tool_call>";
export const TOOL_CLOSE = "</tool_call>";
export const RESULT_OPEN = "<tool_result";

export function renderPrompt(context: TranscriptContext, tools: readonly Tool[]): string {
	const collapsed = collapseSystemMessages(context);
	const parts: string[] = [];
	const system = getCurrentSystemPrompt(collapsed.messages);
	if (system) parts.push(`<system>\n${system}\n</system>`);
	if (tools.length) parts.push(renderTools(tools));
	const turns = collapsed.messages.map(renderMessage).filter(Boolean);
	parts.push(`<conversation>\n${turns.join("\n\n")}\n</conversation>`);
	parts.push(
		"Write only the assistant's next reply to continue the conversation above. Do not use any built-in tools of your own.",
	);
	return parts.join("\n\n");
}

function renderTools(tools: readonly Tool[]): string {
	const list = tools
		.map(
			(tool) =>
				`- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`,
		)
		.join("\n");
	return [
		"<tools>",
		"You can call these tools. To call one, write exactly one block per call:",
		`${TOOL_OPEN}{"name": "<tool name>", "arguments": {<arguments as JSON>}}${TOOL_CLOSE}`,
		"After your tool calls, stop writing. The results arrive in the next turn as tool result blocks; never write those yourself.",
		list,
		"</tools>",
	].join("\n");
}

function renderMessage(message: Message): string {
	switch (message.role) {
		case "system":
			return "";
		case "user": {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((part) => (part.type === "text" ? part.text : "[image omitted]"))
							.join("\n");
			return `<user>\n${text}\n</user>`;
		}
		case "assistant": {
			const body = message.content
				.map((part) => {
					if (part.type === "text") return part.text;
					if (part.type === "toolCall") {
						return `${TOOL_OPEN}${JSON.stringify({ name: part.name, arguments: part.arguments })}${TOOL_CLOSE}`;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
			return body ? `<assistant>\n${body}\n</assistant>` : "";
		}
		case "toolResult": {
			const text = message.content
				.map((part) => (part.type === "text" ? part.text : "[image omitted]"))
				.join("\n");
			const error = message.isError ? ' error="true"' : "";
			return `${RESULT_OPEN} name="${message.toolName}"${error}>\n${text}\n</tool_result>`;
		}
	}
}
