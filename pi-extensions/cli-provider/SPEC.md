---
id: module-pi-cli-provider
type: module-design
status: draft
title: "@thinkrail/pi-cli-provider — a command-line model tool as a pi provider"
parent: module-pi-extensions
tags: [pi-extension, providers]
---

## Responsibility

Turns a command-line model tool (Gemini CLI, or an internal one shaped like it) into a pi model provider,
so its models appear in pi's model picker — and therefore ThinkRail's — with no host change. pi stays the
only agent runtime: the CLI is used as a text completer, never as a second agent loop.

## Public surface

- **Default export**: the `ExtensionFactory` pi loads. It reads `cli-providers.json` from pi's agent dir
  (`getAgentDir()`, so it follows `PI_CODING_AGENT_DIR` and ThinkRail's chosen pi folder) and registers
  one provider per entry; a missing file registers nothing, an invalid entry throws at load.
  `createCliProviderExtension({ providers })` takes the entries directly instead.
- **Config entry** (`CliProviderConfig`): `id`, `name`, `command`, `args` (`{model}` and, with
  `prompt: "arg"`, `{prompt}` placeholders), `prompt` (`stdin` default), `output` (`text` default or
  `jsonl` with dotted-path `text` / `usage` / `error` selectors, each with an optional field `match`),
  `tools` (`prompted` default or `none`), `env`, `models`. `cli-providers.example.json` is the Gemini CLI
  reference.
- `cliProviderRegistration(entry)` — the validated `ProviderConfig` one entry registers, shared by the
  factory and by an embedder that registers into its own runtime (ThinkRail's host does).
- `streamCli` and `renderPrompt` are exported for embedders and tests.

## Decisions

- **One spawn per turn.** The whole normalized transcript is rendered as one prompt (system prompt,
  tools, then `<user>` / `<assistant>` / `<tool_result>` blocks). Images are replaced by a placeholder;
  thinking blocks are not replayed. The models are declared text-only, non-reasoning, zero-cost.
- **Prompted tool calls.** CLIs have no structured tool-call channel, so pi's tools are described in the
  prompt and the model answers with `<tool_call>{"name","arguments"}</tool_call>` blocks, parsed while
  streaming into balanced `toolcall_*` events. Text that could be the start of a marker is held back
  until it resolves. A block naming an unknown tool or holding invalid JSON is passed through as text.
  Once a call is emitted, a model-written `<tool_result` ends the turn and kills the process instead of
  letting the model invent results.
- **Stream contract.** `start` is emitted on the child's `spawn`; a spawn failure (e.g. `ENOENT`) is a
  direct `error`. Exactly one terminal `done` (`toolUse` when a call was emitted, else `stop`) or
  `error` follows. Abort sends `SIGTERM` and ends `aborted`. A non-zero exit ends `error` with the stderr
  tail; a `jsonl.error` event wins over the exit code. `onPayload` receives (and may replace)
  `{ command, args, prompt }`; `onResponse` fires with a synthetic 200; `onProviderStreamEvent` sees each
  parsed JSON line. Usage is what the CLI reports, else zero; pi computes cost from the catalog.
- `baseUrl` (`cli://<command>`) and `apiKey` (`local-cli`) are placeholders pi's registration requires;
  neither is sent anywhere.

## Status

`private` and unpublished: not yet under the vanilla-parity gate. ThinkRail does not load it as an
extension: its host registers `cli-providers.json` itself and edits it from Settings → Providers →
Command-line tools ([[submodule-server-agent]] § `cliProviders`). Vanilla pi uses it by listing the
package path in pi's `packages` or symlinking it into `~/.pi/agent/extensions/`. The
Gemini event selectors in the example follow Gemini CLI's `stream-json` events and need confirming
against a live run before any publish.

## Boundary

- **Allowed deps:** pi SDK peers (`pi-ai`, `pi-coding-agent`) and `node:` builtins.
- **Forbidden:** everything [[module-pi-extensions]] § Boundary forbids.
