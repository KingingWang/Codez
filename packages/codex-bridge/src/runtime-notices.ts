import {
  CODEX_RUNTIME_NOTICE_LIMITS,
  runtimeNoticeSchema,
  type RuntimeNotice,
} from "@codez/shared/codez-protocol-v4";
import type { CodexNotification } from "./contract.js";

const MAX_TARGET_THREADS = 64;
const RUNTIME_NOTICE_METHODS = new Set([
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
]);

export function isRuntimeNoticeMethod(method: string): boolean {
  return RUNTIME_NOTICE_METHODS.has(method);
}

export type RuntimeNoticeChange = { scope: "workspace" } | { scope: "thread"; threadId: string };

type NoticeDraft = Omit<RuntimeNotice, "id" | "at">;
interface NoticeEntry {
  notice: RuntimeNotice;
  fingerprint: string;
  recoveryKey?: string;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function identity(value: unknown, max = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function configDetail(params: Record<string, unknown>): string | undefined {
  const details = typeof params.details === "string" ? params.details.trim() : "";
  const path = typeof params.path === "string" ? params.path.trim() : "";
  let location = path;
  if (path && params.range && typeof params.range === "object" && !Array.isArray(params.range)) {
    const range = params.range as Record<string, unknown>;
    const start = range.start && typeof range.start === "object" ? range.start : undefined;
    const end = range.end && typeof range.end === "object" ? range.end : undefined;
    const position = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const point = value as Record<string, unknown>;
      return typeof point.line === "number" && typeof point.column === "number"
        ? `${point.line}:${point.column}`
        : undefined;
    };
    const startText = position(start);
    const endText = position(end);
    if (startText) location += `:${startText}${endText ? `-${endText}` : ""}`;
  }
  return boundedText(
    [details, location].filter(Boolean).join("\n"),
    CODEX_RUNTIME_NOTICE_LIMITS.maxDetailChars,
  );
}

function fingerprint(draft: NoticeDraft): string {
  return JSON.stringify(draft);
}

/** Bounded process-lifetime projection of native notices; no durable thread facts live here. */
export class RuntimeNoticeStore {
  private readonly globalEntries: NoticeEntry[] = [];
  private readonly threadEntries = new Map<string, NoticeEntry[]>();
  private nextId = 0;

  constructor(private readonly now: () => number = Date.now) {}

  list(threadId: string): RuntimeNotice[] {
    return [...this.globalEntries, ...(this.threadEntries.get(threadId) ?? [])].map(
      (entry) => entry.notice,
    );
  }

  remove(threadId: string): void {
    this.threadEntries.delete(threadId);
  }

  apply(event: CodexNotification): RuntimeNoticeChange | undefined {
    const rawParams = event.params;
    if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) return undefined;
    const params = rawParams as Record<string, unknown>;
    if (event.method === "thread/deleted") {
      const threadId = identity(params.threadId);
      if (threadId) this.remove(threadId);
      return undefined;
    }
    if (event.method === "configWarning" || event.method === "deprecationNotice") {
      const message = boundedText(params.summary, CODEX_RUNTIME_NOTICE_LIMITS.maxMessageChars);
      if (!message) return undefined;
      const detail =
        event.method === "configWarning"
          ? configDetail(params)
          : boundedText(params.details, CODEX_RUNTIME_NOTICE_LIMITS.maxDetailChars);
      const draft: NoticeDraft = {
        kind: event.method,
        message,
        ...(detail ? { detail } : {}),
      };
      return this.appendGlobal(draft) ? { scope: "workspace" } : undefined;
    }
    if (event.method === "warning" || event.method === "guardianWarning") {
      const message = boundedText(params.message, CODEX_RUNTIME_NOTICE_LIMITS.maxMessageChars);
      if (!message) return undefined;
      if (event.method === "warning" && params.threadId === null) {
        return this.appendGlobal({ kind: "warning", message }) ? { scope: "workspace" } : undefined;
      }
      const threadId = identity(params.threadId);
      if (!threadId) return undefined;
      const kind = event.method === "warning" ? "warning" : "guardianWarning";
      return this.appendThread(threadId, { kind, message })
        ? { scope: "thread", threadId }
        : undefined;
    }
    if (
      event.method === "modelProvider/authRecoveryStarted" ||
      event.method === "modelProvider/authRecoveryCompleted"
    ) {
      const threadId = identity(params.threadId);
      const turnId = identity(params.turnId);
      const provider = identity(params.provider, 160);
      const message = boundedText(params.message, CODEX_RUNTIME_NOTICE_LIMITS.maxMessageChars);
      if (!threadId || !turnId || !provider || !message) return undefined;
      const phase = event.method.endsWith("Started") ? "started" : "completed";
      return this.appendThread(
        threadId,
        { kind: "authRecovery", message, turnId, provider, phase },
        `${threadId}\0${turnId}\0${provider}`,
      )
        ? { scope: "thread", threadId }
        : undefined;
    }
    return undefined;
  }

  private appendGlobal(draft: NoticeDraft): boolean {
    return this.append(this.globalEntries, draft);
  }

  private appendThread(threadId: string, draft: NoticeDraft, recoveryKey?: string): boolean {
    // 修复原因：warning/auth recovery 可能早于 thread load；独立缓存避免被未加载线程门禁吞掉。
    let entries = this.threadEntries.get(threadId);
    if (!entries) {
      if (this.threadEntries.size >= MAX_TARGET_THREADS) {
        const oldest = this.threadEntries.keys().next().value;
        if (oldest !== undefined) this.threadEntries.delete(oldest);
      }
      entries = [];
      this.threadEntries.set(threadId, entries);
    }
    const changed = this.append(entries, draft, recoveryKey);
    if (!changed && entries.length === 0) this.threadEntries.delete(threadId);
    return changed;
  }

  private append(entries: NoticeEntry[], draft: NoticeDraft, recoveryKey?: string): boolean {
    const nextFingerprint = fingerprint(draft);
    const existingIndex = recoveryKey
      ? entries.findIndex((entry) => entry.recoveryKey === recoveryKey)
      : -1;
    const previous = existingIndex >= 0 ? entries[existingIndex] : entries.at(-1);
    if (previous?.fingerprint === nextFingerprint && (recoveryKey ? existingIndex >= 0 : true))
      return false;
    const id =
      existingIndex >= 0 && previous ? previous.notice.id : `native-notice-${++this.nextId}`;
    if (existingIndex >= 0) entries.splice(existingIndex, 1);
    const notice = runtimeNoticeSchema.parse({
      ...draft,
      id,
      at: Math.max(0, Math.floor(this.now())),
    });
    entries.push({ notice, fingerprint: nextFingerprint, ...(recoveryKey ? { recoveryKey } : {}) });
    const limit =
      entries === this.globalEntries
        ? CODEX_RUNTIME_NOTICE_LIMITS.maxGlobal
        : CODEX_RUNTIME_NOTICE_LIMITS.maxPerThread;
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    return true;
  }
}
