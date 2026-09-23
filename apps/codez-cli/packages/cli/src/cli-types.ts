import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@codez/tui";
import type { UiLocale } from "@codez/i18n";
import type { Logger } from "@codez/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@codez/adapters/browser";
import type {
  createModelAdapter,
  createCodezApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectCodezSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectCodezCustomCommand,
  InspectCodezCustomCommandOptions,
  InspectCodezSkillOptions,
  loginCodezCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginCodezCliOptions,
  listCodezCustomCommands,
  ListCodezCustomCommandsOptions,
  loadCodezCustomCommand,
  listCodezSessions,
  listCodezSkills,
  ListCodezSessionsOptions,
  ListCodezSkillsOptions,
  logoutCodezCli,
  LogoutCodezCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunCodezProtocolAgentOptions,
  prepareCodezTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownCodezTelemetry,
  CodezAppOptions,
} from "@codez/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@codez/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunCodezProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createCodezApp?: (
    options?: CodezAppOptions,
  ) => Awaited<ReturnType<typeof createCodezApp>> | ReturnType<typeof createCodezApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createCodezApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectCodezSkillOptions) => ReturnType<typeof inspectCodezSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectCodezCustomCommandOptions,
  ) => ReturnType<typeof inspectCodezCustomCommand>;
  loginCodezCli?: (options?: LoginCodezCliOptions) => ReturnType<typeof loginCodezCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareCodezTelemetryEnv?: typeof prepareCodezTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListCodezSessionsOptions) => ReturnType<typeof listCodezSessions>;
  listCustomCommands?: (
    options: ListCodezCustomCommandsOptions,
  ) => ReturnType<typeof listCodezCustomCommands>;
  loadCustomCommand?: (
    options: InspectCodezCustomCommandOptions,
  ) => ReturnType<typeof loadCodezCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedCodezSlashCommandName"];
  listSkills?: (options: ListCodezSkillsOptions) => ReturnType<typeof listCodezSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutCodezCli?: (options?: LogoutCodezCliOptions) => ReturnType<typeof logoutCodezCli>;
  runCodezProtocolAgent?: (options?: RunCodezProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@codez/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownCodezTelemetry?: typeof shutdownCodezTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createCodezApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
