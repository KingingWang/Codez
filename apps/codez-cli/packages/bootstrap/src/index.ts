// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListCodezSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunCodezProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  CodezApp,
  CodezAppOptions,
  CodezModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectCodezCustomCommand,
  listCodezCustomCommands,
  loadCodezCustomCommand,
} from "./custom-commands.js";
export type {
  InspectCodezCustomCommandOptions,
  ListCodezCustomCommandsOptions,
  CodezCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addCodezPluginMarketplace,
  getCodezPluginsOverview,
  installCodezMarketplacePlugin,
  listCodezPlugins,
  removeCodezPluginMarketplace,
  resolveCodezPlugins,
  setCodezPluginEnabled,
  uninstallCodezMarketplacePlugin,
  updateCodezMarketplacePlugin,
  updateCodezPluginMarketplace,
  validateCodezPluginPath,
} from "./plugins.js";
export type {
  AddCodezMarketplaceOptions,
  InstallCodezMarketplacePluginOptions,
  ListCodezPluginsOptions,
  RemoveCodezMarketplaceOptions,
  ResolveCodezPluginsOptions,
  SetCodezPluginEnabledOptions,
  SetCodezPluginEnabledResult,
  UninstallCodezMarketplacePluginOptions,
  UpdateCodezMarketplaceOptions,
  UpdateCodezMarketplacePluginOptions,
  ValidateCodezPluginPathOptions,
  CodezAvailablePluginData,
  CodezInstalledPluginData,
  CodezMarketplaceSummaryData,
  CodezMarketplaceUpdateData,
  CodezPluginInstallData,
  CodezPluginUpdateData,
  CodezPluginsOverviewData,
} from "./plugins.js";
export { runCodezProtocolAgent } from "./codez-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./codez-protocol/session-mapper.js";
export { prepareCodezTelemetryEnv, shutdownCodezTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listCodezSessions, resolveLatestSession } from "./sessions.js";
export { inspectCodezSkill, listCodezSkills } from "./skills.js";
export type {
  InspectCodezSkillOptions,
  ListCodezSkillsOptions,
  CodezSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedCodezSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
