import {
	RiPlayLine as Play,
	RiAddLine as Plus,
	RiDeleteBin6Line as Trash2,
} from "@remixicon/react";
import { CLI_PROVIDERS_PROTOCOL_VERSION, type CliProvider } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { cn } from "@thinkrail/ui/utils";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import {
	SETTINGS_LIST_PRIMARY,
	SETTINGS_LIST_ROW,
	SettingsGroup,
	SettingsLine,
	SettingsList,
	SettingsRow,
	useSettingsListRow,
} from "@/settingsKit";
import { toast, useAppStore } from "@/store";
import { errorText, getTransport } from "@/transport";
import { ConfirmDialog } from "./ConfirmDialog";
import {
	addModelRow,
	type CliDraft,
	canSaveCliDraft,
	cliDraftParams,
	editCliDraft,
	filledModels,
	geminiCliDraft,
	isCountText,
	newCliDraft,
	removeModelRow,
	updateModelRow,
} from "./cliProviderDraft";
import { SETTING, settingProps } from "./settingsCatalog";

const INPUT_CLASS =
	"h-32 w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default transition-colors placeholder:text-text-muted focus:border-control-border-active focus-visible:focus-ring disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text aria-invalid:border-feedback-error";
const TEXTAREA_CLASS =
	"min-h-64 w-full min-w-0 resize-y rounded-sm border border-control-border-default bg-control-bg px-8 py-6 tr-code-text text-text-default transition-colors placeholder:text-text-muted focus:border-control-border-active focus-visible:focus-ring disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text";

type Status = { tone: "ok" | "error"; text: string } | null;

function supported(protocolVersion: number | null): boolean {
	return protocolVersion !== null && protocolVersion >= CLI_PROVIDERS_PROTOCOL_VERSION;
}

function Field({
	label,
	hint,
	htmlFor,
	children,
}: {
	label: string;
	hint?: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4">
			<label htmlFor={htmlFor} className="tr-title-compact text-text-default">
				{label}
			</label>
			{children}
			{hint ? <p className="tr-text-metadata text-text-muted">{hint}</p> : null}
		</div>
	);
}

function Choice<T extends string>({
	value,
	options,
	disabled,
	testId,
	onChange,
}: {
	value: T;
	options: ReadonlyArray<{ value: T; label: string }>;
	disabled: boolean;
	testId: string;
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex flex-wrap gap-4">
			{options.map((option) => (
				<Button
					key={option.value}
					variant="outline"
					size="s"
					data-testid={testId}
					data-value={option.value}
					disabled={disabled}
					selected={value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</Button>
			))}
		</div>
	);
}

function CliProviderDialog({
	initial,
	onClose,
	onSaved,
}: {
	initial: CliDraft;
	onClose: () => void;
	onSaved: (providers: CliProvider[]) => void;
}) {
	const t = useT();
	const id = useId();
	const [draft, setDraft] = useState(initial);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [status, setStatus] = useState<Status>(null);
	const busy = saving || testing;
	const valid = canSaveCliDraft(draft);
	const set = (patch: Partial<CliDraft>) => setDraft((current) => ({ ...current, ...patch }));

	const save = () => {
		if (!valid) return;
		setSaving(true);
		setStatus(null);
		void getTransport()
			.request("cliProviders.save", cliDraftParams(draft))
			.then((providers) => {
				onSaved(providers);
				onClose();
			})
			.catch((error: unknown) => setStatus({ tone: "error", text: errorText(error) }))
			.finally(() => setSaving(false));
	};

	const test = () => {
		const model = filledModels(draft)[0];
		if (!valid || !model) return;
		setTesting(true);
		setStatus({ tone: "ok", text: t("settings.cliProviders.testing") });
		void getTransport()
			.request("cliProviders.test", { draft: cliDraftParams(draft), modelId: model.id.trim() })
			.then((result) =>
				setStatus(
					result.ok
						? { tone: "ok", text: t("settings.cliProviders.testOk", { reply: result.reply }) }
						: {
								tone: "error",
								text: t("settings.cliProviders.testFailed", { error: result.error }),
							},
				),
			)
			.catch((error: unknown) => setStatus({ tone: "error", text: errorText(error) }))
			.finally(() => setTesting(false));
	};

	return (
		<Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
			<DialogContent data-testid="cli-providers-dialog" className="max-w-[40rem]">
				<DialogHeader>
					<DialogTitle>
						{draft.id ? t("settings.cliProviders.editTitle") : t("settings.cliProviders.addTitle")}
					</DialogTitle>
					<DialogDescription>{t("settings.cliProviders.dialogDescription")}</DialogDescription>
				</DialogHeader>
				<div className="-mx-16 relative flex min-h-0 flex-1 flex-col gap-12 overflow-y-auto px-16">
					<div className="flex flex-wrap items-center gap-4">
						<span className="tr-text-metadata text-text-muted">
							{t("settings.cliProviders.presets")}
						</span>
						<Button
							variant="outline"
							size="s"
							data-testid="cli-providers-preset"
							data-preset="gemini"
							disabled={busy}
							onClick={() => setDraft(geminiCliDraft(draft))}
						>
							{t("settings.cliProviders.presetGemini")}
						</Button>
					</div>
					<Field label={t("settings.cliProviders.name")} htmlFor={`${id}-name`}>
						<input
							id={`${id}-name`}
							data-testid="cli-providers-name"
							className={INPUT_CLASS}
							value={draft.name}
							disabled={busy}
							onChange={(event) => set({ name: event.currentTarget.value })}
						/>
					</Field>
					<Field
						label={t("settings.cliProviders.command")}
						hint={t("settings.cliProviders.commandHint")}
						htmlFor={`${id}-command`}
					>
						<input
							id={`${id}-command`}
							data-testid="cli-providers-command"
							className={cn(INPUT_CLASS, "tr-code-text")}
							value={draft.command}
							disabled={busy}
							spellCheck={false}
							placeholder={t("settings.cliProviders.commandPlaceholder")}
							onChange={(event) => set({ command: event.currentTarget.value })}
						/>
					</Field>
					<Field
						label={t("settings.cliProviders.args")}
						hint={t("settings.cliProviders.argsHint")}
						htmlFor={`${id}-args`}
					>
						<textarea
							id={`${id}-args`}
							data-testid="cli-providers-args"
							className={TEXTAREA_CLASS}
							value={draft.args}
							disabled={busy}
							spellCheck={false}
							onChange={(event) => set({ args: event.currentTarget.value })}
						/>
					</Field>
					<Field label={t("settings.cliProviders.prompt")}>
						<Choice
							value={draft.prompt}
							disabled={busy}
							testId="cli-providers-prompt"
							options={[
								{ value: "stdin", label: t("settings.cliProviders.promptStdin") },
								{ value: "arg", label: t("settings.cliProviders.promptArg") },
							]}
							onChange={(prompt) => set({ prompt })}
						/>
					</Field>
					<Field label={t("settings.cliProviders.output")}>
						<Choice
							value={draft.output}
							disabled={busy}
							testId="cli-providers-output"
							options={[
								{ value: "text", label: t("settings.cliProviders.outputText") },
								{ value: "jsonl", label: t("settings.cliProviders.outputJsonl") },
							]}
							onChange={(output) => set({ output })}
						/>
					</Field>
					{draft.output === "jsonl" ? (
						<div className="flex flex-col gap-8 rounded-sm border border-border-muted p-12">
							<p className="tr-text-metadata text-text-muted">
								{t("settings.cliProviders.jsonlHint")}
							</p>
							<SelectorRow
								label={t("settings.cliProviders.textEvents")}
								match={draft.textMatch}
								fields={[
									{
										value: draft.textPath,
										key: "textPath",
										label: t("settings.cliProviders.textPath"),
									},
								]}
								disabled={busy}
								testId="cli-providers-text"
								onMatch={(textMatch) => set({ textMatch })}
								onField={(_, textPath) => set({ textPath })}
							/>
							<SelectorRow
								label={t("settings.cliProviders.usageEvents")}
								match={draft.usageMatch}
								fields={[
									{
										value: draft.usageInput,
										key: "usageInput",
										label: t("settings.cliProviders.usageInput"),
									},
									{
										value: draft.usageOutput,
										key: "usageOutput",
										label: t("settings.cliProviders.usageOutput"),
									},
									{
										value: draft.usageTotal,
										key: "usageTotal",
										label: t("settings.cliProviders.usageTotal"),
									},
								]}
								disabled={busy}
								testId="cli-providers-usage"
								onMatch={(usageMatch) => set({ usageMatch })}
								onField={(key, value) => set({ [key]: value })}
							/>
							<SelectorRow
								label={t("settings.cliProviders.errorEvents")}
								match={draft.errorMatch}
								fields={[
									{
										value: draft.errorPath,
										key: "errorPath",
										label: t("settings.cliProviders.errorPath"),
									},
								]}
								disabled={busy}
								testId="cli-providers-error"
								onMatch={(errorMatch) => set({ errorMatch })}
								onField={(_, errorPath) => set({ errorPath })}
							/>
						</div>
					) : null}
					<Field
						label={t("settings.cliProviders.tools")}
						hint={t("settings.cliProviders.toolsHint")}
					>
						<Choice
							value={draft.tools}
							disabled={busy}
							testId="cli-providers-tools"
							options={[
								{ value: "prompted", label: t("settings.cliProviders.toolsPrompted") },
								{ value: "none", label: t("settings.cliProviders.toolsNone") },
							]}
							onChange={(tools) => set({ tools })}
						/>
					</Field>
					<Field
						label={t("settings.cliProviders.env")}
						hint={t("settings.cliProviders.envHint")}
						htmlFor={`${id}-env`}
					>
						<textarea
							id={`${id}-env`}
							data-testid="cli-providers-env"
							className={TEXTAREA_CLASS}
							value={draft.env}
							disabled={busy}
							spellCheck={false}
							onChange={(event) => set({ env: event.currentTarget.value })}
						/>
					</Field>
					<div className="flex flex-col gap-4">
						<div className="flex items-center justify-between gap-8">
							<span className="tr-title-compact text-text-default">
								{t("settings.cliProviders.models")}
							</span>
							<Button
								variant="outline"
								size="m"
								iconLeft={Plus}
								data-testid="cli-providers-model-add"
								disabled={busy}
								onClick={() => setDraft(addModelRow(draft))}
							>
								{t("settings.cliProviders.addModel")}
							</Button>
						</div>
						<ul className="flex flex-col gap-8" data-testid="cli-providers-models">
							{draft.models.map((model) => (
								<li
									key={model.key}
									data-testid="cli-providers-model"
									className="flex items-center gap-8"
								>
									<input
										data-testid="cli-providers-model-id"
										aria-label={t("settings.cliProviders.modelId")}
										placeholder={t("settings.cliProviders.modelId")}
										className={cn(INPUT_CLASS, "tr-code-text")}
										value={model.id}
										disabled={busy}
										spellCheck={false}
										onChange={(event) =>
											setDraft(updateModelRow(draft, model.key, { id: event.currentTarget.value }))
										}
									/>
									<input
										data-testid="cli-providers-model-name"
										aria-label={t("settings.cliProviders.modelName")}
										placeholder={t("settings.cliProviders.modelName")}
										className={INPUT_CLASS}
										value={model.name}
										disabled={busy}
										onChange={(event) =>
											setDraft(
												updateModelRow(draft, model.key, { name: event.currentTarget.value }),
											)
										}
									/>
									<input
										inputMode="numeric"
										data-testid="cli-providers-model-context"
										aria-label={t("settings.cliProviders.modelContext")}
										placeholder={t("settings.cliProviders.modelContext")}
										aria-invalid={!isCountText(model.contextWindow) || undefined}
										className={cn(INPUT_CLASS, "w-112 shrink-0 text-right tr-code-text")}
										value={model.contextWindow}
										disabled={busy}
										onChange={(event) =>
											setDraft(
												updateModelRow(draft, model.key, {
													contextWindow: event.currentTarget.value,
												}),
											)
										}
									/>
									<input
										inputMode="numeric"
										data-testid="cli-providers-model-max"
										aria-label={t("settings.cliProviders.modelMaxTokens")}
										placeholder={t("settings.cliProviders.modelMaxTokens")}
										aria-invalid={!isCountText(model.maxTokens) || undefined}
										className={cn(INPUT_CLASS, "w-112 shrink-0 text-right tr-code-text")}
										value={model.maxTokens}
										disabled={busy}
										onChange={(event) =>
											setDraft(
												updateModelRow(draft, model.key, { maxTokens: event.currentTarget.value }),
											)
										}
									/>
									<IconButton
										icon={Trash2}
										label={t("settings.cliProviders.removeModel")}
										data-testid="cli-providers-model-remove"
										disabled={busy || draft.models.length === 1}
										onClick={() => setDraft(removeModelRow(draft, model.key))}
									/>
								</li>
							))}
						</ul>
					</div>
					{status ? (
						<p
							role={status.tone === "error" ? "alert" : "status"}
							data-testid="cli-providers-status"
							data-tone={status.tone}
							className={cn(
								"whitespace-pre-wrap break-words tr-text-metadata",
								status.tone === "error" ? "text-feedback-error" : "text-text-muted",
							)}
						>
							{status.text}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						iconLeft={Play}
						data-testid="cli-providers-test"
						loading={testing}
						disabled={busy || !valid}
						onClick={test}
					>
						{t("settings.cliProviders.test")}
					</Button>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						data-testid="cli-providers-save"
						loading={saving}
						disabled={busy || !valid}
						onClick={save}
					>
						{t("common.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type SelectorKey = "textPath" | "usageInput" | "usageOutput" | "usageTotal" | "errorPath";

function SelectorRow({
	label,
	match,
	fields,
	disabled,
	testId,
	onMatch,
	onField,
}: {
	label: string;
	match: string;
	fields: ReadonlyArray<{ key: SelectorKey; value: string; label: string }>;
	disabled: boolean;
	testId: string;
	onMatch: (value: string) => void;
	onField: (key: SelectorKey, value: string) => void;
}) {
	const t = useT();
	return (
		<div className="flex flex-col gap-4" data-testid={testId}>
			<span className="tr-text-ui text-text-default">{label}</span>
			<div className="flex flex-wrap items-center gap-8">
				<input
					data-testid={`${testId}-match`}
					aria-label={t("settings.cliProviders.matchLabel", { name: label })}
					placeholder={t("settings.cliProviders.matchPlaceholder")}
					className={cn(INPUT_CLASS, "min-w-160 flex-1 tr-code-text")}
					value={match}
					disabled={disabled}
					spellCheck={false}
					onChange={(event) => onMatch(event.currentTarget.value)}
				/>
				{fields.map((field) => (
					<input
						key={field.key}
						data-testid={`${testId}-${field.key}`}
						aria-label={field.label}
						placeholder={field.label}
						className={cn(INPUT_CLASS, "min-w-112 flex-1 tr-code-text")}
						value={field.value}
						disabled={disabled}
						spellCheck={false}
						onChange={(event) => onField(field.key, event.currentTarget.value)}
					/>
				))}
			</div>
		</div>
	);
}

export interface CliProvidersState {
	providers: CliProvider[] | null;
	failed: boolean;
	load: () => Promise<void>;
	replace: (next: CliProvider[]) => void;
}

export function useCliProviders(): CliProvidersState | null {
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const providerVersion = useAppStore((state) => state.providerVersion);
	const [providers, setProviders] = useState<CliProvider[] | null>(null);
	const [failed, setFailed] = useState(false);
	const sequence = useRef(0);

	const load = useCallback(async () => {
		if (!supported(protocolVersion)) return;
		const current = ++sequence.current;
		try {
			const next = await getTransport().request("cliProviders.list", {});
			if (current !== sequence.current) return;
			setProviders(next);
			setFailed(false);
		} catch {
			if (current === sequence.current) setFailed(true);
		}
	}, [protocolVersion]);

	useEffect(() => {
		void load();
	}, [load, providerVersion]);

	const replace = useCallback((next: CliProvider[]) => {
		sequence.current++;
		setProviders(next);
	}, []);

	if (!supported(protocolVersion)) return null;
	return { providers, failed, load, replace };
}

function CliProviderRow({
	provider,
	onEdit,
	onRemove,
}: {
	provider: CliProvider;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const t = useT();
	const { rowProps, primaryProps, sideProps } = useSettingsListRow(provider.id);
	return (
		<li
			{...rowProps}
			data-testid="cli-providers-provider"
			data-provider={provider.id}
			className={SETTINGS_LIST_ROW}
		>
			<button
				type="button"
				{...primaryProps}
				data-testid="cli-providers-edit"
				aria-label={t("settings.cliProviders.editLabel", { name: provider.name })}
				onClick={onEdit}
				className={SETTINGS_LIST_PRIMARY}
			>
				<span className="tr-text-ui text-text-default">{provider.name}</span>
				<span className="break-all tr-text-metadata text-text-muted">
					{t("settings.cliProviders.summary", {
						command: provider.command,
						count: provider.models.length,
					})}
				</span>
			</button>
			<Button
				variant="ghost"
				size="m"
				iconLeft={Trash2}
				{...sideProps}
				data-testid="cli-providers-remove"
				aria-label={t("settings.cliProviders.removeLabel", { name: provider.name })}
				onClick={onRemove}
			>
				{t("common.remove")}
			</Button>
		</li>
	);
}

export function CliProvidersSettings({
	state: { providers, failed, load, replace },
}: {
	state: CliProvidersState;
}) {
	const t = useT();
	const [dialog, setDialog] = useState<CliDraft | null>(null);
	const [removing, setRemoving] = useState<CliProvider | null>(null);
	const row = settingProps(t, SETTING.cliTools);
	const list = providers ?? [];

	const remove = async (provider: CliProvider) => {
		try {
			replace(await getTransport().request("cliProviders.remove", { id: provider.id }));
		} catch (error) {
			toast.error(errorText(error), t("settings.cliProviders.removeFailed"));
		}
	};

	const addButton = (fallback: boolean) => (
		<Button
			variant="outline"
			size="m"
			iconLeft={Plus}
			tabIndex={0}
			data-testid="cli-providers-add"
			data-focus-fallback={fallback ? row.settingId : undefined}
			onClick={() => setDialog(newCliDraft())}
		>
			{t("settings.cliProviders.add")}
		</Button>
	);

	return (
		<SettingsGroup title={row.label} description={row.description} testId="settings-cli-providers">
			{failed ? (
				<SettingsRow
					{...row}
					description={t("settings.cliProviders.loadFailed")}
					control={
						<Button
							variant="outline"
							size="m"
							tabIndex={0}
							data-testid="cli-providers-retry"
							onClick={() => void load()}
						>
							{t("common.retry")}
						</Button>
					}
				/>
			) : providers === null ? null : list.length === 0 ? (
				<SettingsLine
					rowId={row.settingId}
					settingId={row.settingId}
					testId="cli-providers-empty"
					framed
					className="my-8 flex flex-wrap items-center gap-12 rounded-sm border border-border-default border-dashed p-12"
				>
					<span className="flex min-w-160 flex-1 flex-col gap-2">
						<span className="tr-text-ui text-text-default">{t("settings.cliProviders.empty")}</span>
						<span className="tr-text-metadata text-text-muted">
							{t("settings.cliProviders.dialogDescription")}
						</span>
					</span>
					{addButton(true)}
				</SettingsLine>
			) : (
				<>
					<SettingsList
						focusList={row.settingId}
						label={row.label}
						rowIds={list.map((provider) => provider.id)}
						settingId={row.settingId}
						onRemove={(id) => setRemoving(list.find((provider) => provider.id === id) ?? null)}
					>
						{list.map((provider) => (
							<CliProviderRow
								key={provider.id}
								provider={provider}
								onEdit={() => setDialog(editCliDraft(provider))}
								onRemove={() => setRemoving(provider)}
							/>
						))}
					</SettingsList>
					<SettingsLine rowId="cli-tools-add" className="py-12">
						{addButton(false)}
					</SettingsLine>
				</>
			)}
			{dialog ? (
				<CliProviderDialog initial={dialog} onClose={() => setDialog(null)} onSaved={replace} />
			) : null}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={t("settings.cliProviders.removeTitle", { name: removing?.name ?? "" })}
				description={t("settings.cliProviders.removeDescription")}
				confirmLabel={t("common.remove")}
				destructive
				confirmTestId="cli-providers-remove-confirm"
				onConfirm={() => {
					if (removing) void remove(removing);
				}}
			/>
		</SettingsGroup>
	);
}
