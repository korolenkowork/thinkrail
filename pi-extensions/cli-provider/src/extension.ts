import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { type CliProviderConfig, loadCliProviders, validateProvider } from "./config.ts";
import { streamCli } from "./stream.ts";

export interface CliProviderExtensionOptions {
	providers?: CliProviderConfig[];
}

export function cliProviderRegistration(provider: CliProviderConfig): ProviderConfig {
	validateProvider(provider);
	const api: Api = `cli-provider:${provider.id}`;
	return {
		name: provider.name ?? provider.id,
		baseUrl: `cli://${provider.command}`,
		apiKey: "local-cli",
		api,
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow ?? 128_000,
			maxTokens: model.maxTokens ?? 8192,
		})),
		streamSimple: (model, context, streamOptions) =>
			streamCli(provider, model, context, streamOptions),
	};
}

export function createCliProviderExtension(
	options: CliProviderExtensionOptions = {},
): ExtensionFactory {
	return (pi) => {
		for (const provider of options.providers ?? loadCliProviders()) {
			pi.registerProvider(provider.id, cliProviderRegistration(provider));
		}
	};
}
