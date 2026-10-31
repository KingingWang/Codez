export type RendererCrashRecoveryOutcome = "reloaded" | "budget-exhausted" | "ignored";

export interface RendererCrashRecovery {
  handle(details: { reason?: string }): RendererCrashRecoveryOutcome;
  readonly autoReloadCount: number;
}

export interface RendererCrashRecoveryInput {
  reload: () => void;
  canReload?: () => boolean;
  schedule?: (task: () => void, delayMs: number) => void;
  reloadDelayMs?: number;
  isQuitting: () => boolean;
  logger: { warn(message: string, payload?: unknown): void };
  maxAutoReloads?: number;
}

/** Window/quitting/liveness facts are supplied by Main; no task or attachment owner is created. */
export type RendererCrashRecoveryFactory = (
  input: RendererCrashRecoveryInput,
) => RendererCrashRecovery;
