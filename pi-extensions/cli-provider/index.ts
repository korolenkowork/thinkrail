import { createCliProviderExtension } from "./src/extension.ts";

export {
	type CliMatch,
	type CliModelConfig,
	type CliProviderConfig,
	CONFIG_FILE,
	configPath,
	loadCliProviders,
} from "./src/config.ts";
export {
	type CliProviderExtensionOptions,
	cliProviderRegistration,
	createCliProviderExtension,
} from "./src/extension.ts";
export { renderPrompt } from "./src/prompt.ts";
export { type CliPayload, streamCli } from "./src/stream.ts";

export default createCliProviderExtension();
