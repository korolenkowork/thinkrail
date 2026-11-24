# @thinkrail/pi-cli-provider

Use a command-line model tool, such as [Gemini CLI](https://github.com/google-gemini/gemini-cli), as a
[pi](https://pi.dev) model provider. Its models show up in pi's model picker (and in ThinkRail's), and
pi's own tools keep working through a prompted tool-call format.

## Set up

1. Load the extension: add this package's folder to `packages` in pi's `settings.json`, or symlink it
   into `~/.pi/agent/extensions/cli-provider`.
2. Copy `cli-providers.example.json` to `~/.pi/agent/cli-providers.json` and edit it.
3. Restart pi (or ThinkRail) and pick one of the new models.

## Configure a provider

| Field | Meaning |
| --- | --- |
| `id`, `name` | Provider id and the name shown in the picker. |
| `command` | The executable. Prefer an absolute path: a desktop app may not see your shell's `PATH`. |
| `args` | Arguments. `{model}` becomes the picked model id; `{prompt}` the prompt when `prompt` is `arg`. |
| `prompt` | `stdin` (default) sends the prompt on standard input; `arg` puts it in `{prompt}`. |
| `output` | `text` (default) streams stdout as the reply; `jsonl` reads one JSON event per line. |
| `jsonl.text` | `{ match, path }`: events matching `match` contribute the string at dotted `path`. |
| `jsonl.usage` | `{ match, input, output, total }`: token counts at dotted paths. |
| `jsonl.error` | `{ match, path }`: an event that marks the turn as failed, with its message. |
| `tools` | `prompted` (default) describes pi's tools and parses `<tool_call>` blocks; `none` is plain chat. |
| `env` | Extra environment variables for the command. |
| `models` | `{ id, name, contextWindow, maxTokens }` for each model the command accepts. |

The command must answer one prompt and exit. If it has built-in tools of its own, turn them off with its
flags so pi stays in charge of files and commands.

## Limits

Text only (images are sent as a placeholder), no thinking blocks, and tool calls depend on the model
following the prompted format.
