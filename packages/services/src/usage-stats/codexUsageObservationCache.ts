import { createHash } from "node:crypto";
export interface CodexObservedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly contextWindow?: { readonly usedTokens?: number; readonly maxTokens?: number };
}

export interface CodexUsageWorkspaceTarget {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface CodexUsageObservation {
  readonly observationId: string;
  readonly payload: Readonly<CodexObservedUsage>;
}

export interface CodexUsageThreadState {
  readonly observation: CodexUsageObservation;
  readonly conflict: boolean;
}

export interface CodexUsageCacheSnapshot {
  readonly workspaceKey: string;
  readonly threads: ReadonlyMap<string, CodexUsageThreadState>;
  readonly conflict: boolean;
  /**
   * Runtime unavailable means the retained facts are still displayable, but they are no
   * longer guaranteed to be current. A new observation transitions this back to current.
   */
  readonly stale: boolean;
}

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Canonical identity deliberately excludes timestamps, update ids, and delivery ids. */
export function codexUsageObservationId(
  workspaceKey: string,
  threadId: string,
  payload: Readonly<CodexObservedUsage>,
): string {
  const context = payload.contextWindow;
  const canonical = {
    contextWindow: {
      ...(safeInteger(context?.maxTokens) ? { maxTokens: context?.maxTokens } : {}),
      ...(safeInteger(context?.usedTokens) ? { usedTokens: context?.usedTokens } : {}),
    },
    ...(safeInteger(payload.inputTokens) ? { inputTokens: payload.inputTokens } : {}),
    ...(safeInteger(payload.outputTokens) ? { outputTokens: payload.outputTokens } : {}),
    ...(safeInteger(payload.cacheReadTokens) ? { cacheReadTokens: payload.cacheReadTokens } : {}),
    ...(safeInteger(payload.cacheWriteTokens)
      ? { cacheWriteTokens: payload.cacheWriteTokens }
      : {}),
    workspaceKey,
    threadId,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function sparseCodexUsage(
  payload: Readonly<CodexObservedUsage>,
): Readonly<CodexObservedUsage> {
  const source = payload as Record<string, unknown>;
  const context = source.contextWindow as Record<string, unknown> | undefined;
  return {
    ...(safeInteger(source.inputTokens) ? { inputTokens: source.inputTokens } : {}),
    ...(safeInteger(source.outputTokens) ? { outputTokens: source.outputTokens } : {}),
    ...(safeInteger(source.cacheReadTokens) ? { cacheReadTokens: source.cacheReadTokens } : {}),
    ...(safeInteger(source.cacheWriteTokens) ? { cacheWriteTokens: source.cacheWriteTokens } : {}),
    ...(context && (safeInteger(context.usedTokens) || safeInteger(context.maxTokens))
      ? {
          contextWindow: {
            ...(safeInteger(context.usedTokens) ? { usedTokens: context.usedTokens } : {}),
            ...(safeInteger(context.maxTokens) ? { maxTokens: context.maxTokens } : {}),
          },
        }
      : {}),
  };
}

function isRegression(
  previous: Readonly<CodexObservedUsage>,
  next: Readonly<CodexObservedUsage>,
): boolean {
  const counters: Array<[number | undefined, number | undefined]> = [
    [previous.inputTokens, next.inputTokens],
    [previous.outputTokens, next.outputTokens],
    [previous.cacheReadTokens, next.cacheReadTokens],
    [previous.cacheWriteTokens, next.cacheWriteTokens],
  ];
  return counters.some(
    ([before, after]) => safeInteger(before) && after !== undefined && after < before,
  );
}

/** Desktop-owned observation cache. It never reads or merges Coding Plan data. */
export class CodexUsageObservationCache {
  private readonly threads = new Map<string, CodexUsageThreadState>();
  private runtimeUnavailable = false;

  constructor(private readonly workspace: CodexUsageWorkspaceTarget) {}

  get workspaceKey(): string {
    return this.workspace.workspaceIdentity?.trim() || this.workspace.workspacePath;
  }

  observe(threadId: string, payload: Readonly<CodexObservedUsage>): boolean {
    const sparse = sparseCodexUsage(payload);
    const observation = {
      observationId: codexUsageObservationId(this.workspaceKey, threadId, sparse),
      payload: sparse,
    };
    const previous = this.threads.get(threadId);
    this.runtimeUnavailable = false;
    if (previous?.observation.observationId === observation.observationId) return false;
    this.threads.set(threadId, {
      observation,
      conflict: previous
        ? previous.conflict || isRegression(previous.observation.payload, sparse)
        : false,
    });
    return true;
  }

  reconcile(threadId: string, payload: Readonly<CodexObservedUsage>): void {
    const sparse = sparseCodexUsage(payload);
    const observation = {
      observationId: codexUsageObservationId(this.workspaceKey, threadId, sparse),
      payload: sparse,
    };
    const previous = this.threads.get(threadId);
    this.runtimeUnavailable = false;
    this.threads.set(threadId, {
      observation,
      conflict: previous?.observation.observationId !== observation.observationId,
    });
  }

  markRuntimeUnavailable(): void {
    this.runtimeUnavailable = true;
  }

  snapshot(): CodexUsageCacheSnapshot {
    return {
      workspaceKey: this.workspaceKey,
      threads: new Map(this.threads),
      conflict: [...this.threads.values()].some((thread) => thread.conflict),
      stale: this.runtimeUnavailable,
    };
  }
}
