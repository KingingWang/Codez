/** Bridge stderr is not a trusted log transport; accept only the bounded fields we emit. */
export type CodexBridgeTitleDiagnostic =
  | { kind: "failed"; stage: string; code: string }
  | { kind: "skipped"; stage: string; reason: string };

export interface CodexBridgeRpcTimeoutDiagnostic {
  method: string;
  durationMs: number;
  pending: number;
}

export type CodexBridgeStateDiagnostic =
  | {
      kind: "snapshotPrepared";
      deliveryKind: "initial" | "recovery";
      sessionId: string;
      subscriptionId: string;
      logEpoch: string;
      seq: number;
      phase: string;
      lastTurnId: string;
    }
  | {
      kind: "continueRejected";
      sessionId: string;
      commandId: string;
      nativeStatus: string;
      latestTurnStatus: string;
      selectedRunningTurnId: string;
      runningTurnCount: number;
      logEpoch: string;
      seq: number;
      revision: number;
    };

export interface CodexBridgeOversizedFrameDiagnostic {
  kind: "response" | "request" | "notification" | "unknown";
  method: string;
  observedBytes: number;
}

export type CodexBridgeNativeStderrCategory =
  | "panic"
  | "permission-denied"
  | "not-found"
  | "connection"
  | "timeout"
  | "tls"
  | "out-of-memory"
  | "error";

export interface CodexBridgeNativeStderrSummary {
  exitCode: number | null;
  signal: string | null;
  lineCount: number;
  byteCount: number;
  truncated: boolean;
  level: "trace" | "debug" | "info" | "warn" | "error" | "unknown";
  target: string;
  categories: CodexBridgeNativeStderrCategory[];
}

export interface CodexBridgeRuntimeNoticeDiagnostic {
  kind: "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" | "authRecovery";
  message: string;
  detail?: string;
  threadId?: string;
  turnId?: string;
  provider?: string;
  phase?: "started" | "completed";
}

// 两份白名单必须与 packages/codex-bridge/src/session-title.ts 的 SkipStage / SkipReason
// 及 generate() 的失败阶段同步；不在闭合词汇内的行按不可信 stderr 丢弃，不进生产日志。
const FAILED =
  /^Codex desktop bridge warn: automatic title failed; stage=(availability|generation|native-read|native-write); code=(-?\d{1,7}|STARTUP|CLOSED|PROTOCOL|TIMEOUT|NOT_READY|LIMIT|INVALID|unknown)$/;
const SKIPPED =
  /^Codex desktop bridge warn: automatic title skipped; stage=(arm|input|availability|generation|native-read); reason=(missing-selection|short-input|unavailable|invalid-title|renamed|first-item-mismatch)$/;
const RPC_TIMEOUT =
  /^Codex desktop bridge warn: native rpc timed out; method=([A-Za-z0-9_/-]{1,64}); durationMs=(\d{1,10}); pending=(\d{1,4})$/;
const OVERSIZED_FRAME =
  /^Codex desktop bridge warn: oversized native frame; kind=(response|request|notification|unknown); method=([A-Za-z0-9_/-]{1,64}); observedBytes=(\d{1,15})$/;
const NATIVE_STDERR_SUMMARY =
  /^Codex desktop bridge warn: native stderr summary; exitCode=(null|\d{1,10}); signal=(null|[A-Z]{1,15}); lineCount=(\d{1,10}); byteCount=(\d{1,16}); truncated=(true|false); level=(trace|debug|info|warn|error|unknown); target=(none|(?:[a-z0-9_]+::){1,5}[a-z0-9_]+); categories=(none|[a-z-]+(?:,[a-z-]+)*)$/;
const STATE_ID = "([A-Za-z0-9_-]{1,64})";
const STATE_NUMBER = "(\\d{1,16})";
const STATE_PREFIX = "^Codex desktop bridge state: ";
const SNAPSHOT_PREPARED = new RegExp(
  `${STATE_PREFIX}snapshotPrepared; deliveryKind=(initial|recovery); sessionId=${STATE_ID}; subscriptionId=${STATE_ID}; logEpoch=${STATE_ID}; seq=${STATE_NUMBER}; phase=(draft|prewarming|running|completedSuccess|completedInterrupted|error); lastTurnId=${STATE_ID}(?![\\s\\S])`,
);
const CONTINUE_REJECTED = new RegExp(
  `${STATE_PREFIX}continueRejected; sessionId=${STATE_ID}; commandId=${STATE_ID}; nativeStatus=(notLoaded|idle|systemError|active|unknown); latestTurnStatus=(inProgress|completed|interrupted|failed|unknown); selectedRunningTurnId=${STATE_ID}; runningTurnCount=(\\d{1,4}); logEpoch=${STATE_ID}; seq=${STATE_NUMBER}; revision=${STATE_NUMBER}(?![\\s\\S])`,
);

export function parseCodexBridgeStateDiagnostic(
  line: string,
): CodexBridgeStateDiagnostic | undefined {
  const snapshot = SNAPSHOT_PREPARED.exec(line);
  if (snapshot) {
    const seq = Number(snapshot[5]);
    if (!Number.isSafeInteger(seq)) return undefined;
    return {
      kind: "snapshotPrepared",
      deliveryKind: snapshot[1] as "initial" | "recovery",
      sessionId: snapshot[2]!,
      subscriptionId: snapshot[3]!,
      logEpoch: snapshot[4]!,
      seq,
      phase: snapshot[6]!,
      lastTurnId: snapshot[7]!,
    };
  }
  const rejected = CONTINUE_REJECTED.exec(line);
  if (!rejected) return undefined;
  const runningTurnCount = Number(rejected[6]);
  const seq = Number(rejected[8]);
  const revision = Number(rejected[9]);
  if (
    !Number.isSafeInteger(runningTurnCount) ||
    runningTurnCount > 9999 ||
    !Number.isSafeInteger(seq) ||
    !Number.isSafeInteger(revision)
  )
    return undefined;
  return {
    kind: "continueRejected",
    sessionId: rejected[1]!,
    commandId: rejected[2]!,
    nativeStatus: rejected[3]!,
    latestTurnStatus: rejected[4]!,
    selectedRunningTurnId: rejected[5]!,
    runningTurnCount,
    logEpoch: rejected[7]!,
    seq,
    revision,
  };
}
const RUNTIME_NOTICE_PREFIX = "Codex desktop bridge warn: runtime notice; payload=";
const RUNTIME_NOTICE_MAX_PAYLOAD_CHARS = 160_000;
const RUNTIME_NOTICE_KINDS = new Set<CodexBridgeRuntimeNoticeDiagnostic["kind"]>([
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "authRecovery",
]);
const RUNTIME_NOTICE_FIELDS = new Set([
  "kind",
  "message",
  "detail",
  "threadId",
  "turnId",
  "provider",
  "phase",
]);
// 与 bridge main.ts 的生产输出闭合词汇一致，禁止把未验证 stderr 当日志透传。
const FRAME_METHODS = new Set([
  "initialize",
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "thread/list",
  "thread/queue/list",
  "unknown",
]);
const NATIVE_STDERR_CATEGORY_VOCABULARY = new Set<CodexBridgeNativeStderrCategory>([
  "panic",
  "permission-denied",
  "not-found",
  "connection",
  "timeout",
  "tls",
  "out-of-memory",
  "error",
]);

export function parseCodexBridgeTitleDiagnostic(
  line: string,
): CodexBridgeTitleDiagnostic | undefined {
  const failed = FAILED.exec(line);
  if (failed) return { kind: "failed", stage: failed[1]!, code: failed[2]! };
  const skipped = SKIPPED.exec(line);
  if (skipped) return { kind: "skipped", stage: skipped[1]!, reason: skipped[2]! };
  return undefined;
}

export function parseCodexBridgeRpcTimeoutDiagnostic(
  line: string,
): CodexBridgeRpcTimeoutDiagnostic | undefined {
  const match = RPC_TIMEOUT.exec(line);
  if (!match) return undefined;
  const durationMs = Number(match[2]);
  const pending = Number(match[3]);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return undefined;
  if (!Number.isSafeInteger(pending) || pending < 0) return undefined;
  return { method: match[1]!, durationMs, pending };
}

export function parseCodexBridgeOversizedFrameDiagnostic(
  line: string,
): CodexBridgeOversizedFrameDiagnostic | undefined {
  const match = OVERSIZED_FRAME.exec(line);
  if (!match || !FRAME_METHODS.has(match[2]!)) return undefined;
  const observedBytes = Number(match[3]);
  if (!Number.isSafeInteger(observedBytes) || observedBytes <= 32 * 1024 * 1024) return undefined;
  return {
    kind: match[1] as CodexBridgeOversizedFrameDiagnostic["kind"],
    method: match[2]!,
    observedBytes,
  };
}

export function parseCodexBridgeNativeStderrSummary(
  line: string,
): CodexBridgeNativeStderrSummary | undefined {
  const match = NATIVE_STDERR_SUMMARY.exec(line);
  if (!match) return undefined;
  const exitCode = match[1] === "null" ? null : Number(match[1]);
  const lineCount = Number(match[3]);
  const byteCount = Number(match[4]);
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode > 4_294_967_295))
    return undefined;
  if (!Number.isSafeInteger(lineCount) || lineCount === 0) return undefined;
  if (!Number.isSafeInteger(byteCount) || byteCount === 0) return undefined;
  // 逐项二次校验闭合类别，避免正则分组自身导致的意外跨类别匹配。
  const categoryNames = match[8] === "none" ? [] : (match[8]!.split(",") as string[]);
  if (
    categoryNames.some(
      (name) => !NATIVE_STDERR_CATEGORY_VOCABULARY.has(name as CodexBridgeNativeStderrCategory),
    )
  )
    return undefined;
  const categories = (
    match[8] === "none" ? [] : match[8]!.split(",")
  ) as CodexBridgeNativeStderrCategory[];
  if (new Set(categories).size !== categories.length) return undefined;
  return {
    exitCode,
    signal: match[2] === "null" ? null : match[2]!,
    lineCount,
    byteCount,
    truncated: match[5] === "true",
    level: match[6] as CodexBridgeNativeStderrSummary["level"],
    target: match[7]!,
    categories,
  };
}

function runtimeNoticeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxChars ? text : undefined;
}

export function parseCodexBridgeRuntimeNoticeDiagnostic(
  line: string,
): CodexBridgeRuntimeNoticeDiagnostic | undefined {
  if (!line.startsWith(RUNTIME_NOTICE_PREFIX)) return undefined;
  const payload = line.slice(RUNTIME_NOTICE_PREFIX.length);
  if (!payload || payload.length > RUNTIME_NOTICE_MAX_PAYLOAD_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RUNTIME_NOTICE_FIELDS.has(key))) return undefined;
  const kind = record.kind;
  if (
    typeof kind !== "string" ||
    !RUNTIME_NOTICE_KINDS.has(kind as CodexBridgeRuntimeNoticeDiagnostic["kind"])
  )
    return undefined;
  const message = runtimeNoticeText(record.message, 4_096);
  if (!message) return undefined;
  const has = (key: string) => Object.hasOwn(record, key);
  const detail = has("detail") ? runtimeNoticeText(record.detail, 16_384) : undefined;
  const threadId = has("threadId") ? runtimeNoticeText(record.threadId, 1_024) : undefined;
  const turnId = has("turnId") ? runtimeNoticeText(record.turnId, 1_024) : undefined;
  const provider = has("provider") ? runtimeNoticeText(record.provider, 160) : undefined;
  if (
    (has("detail") && !detail) ||
    (has("threadId") && !threadId) ||
    (has("turnId") && !turnId) ||
    (has("provider") && !provider)
  )
    return undefined;
  const phase = record.phase;
  if (has("phase") && phase !== "started" && phase !== "completed") return undefined;

  if (kind === "configWarning" || kind === "deprecationNotice") {
    if (threadId || turnId || provider || phase) return undefined;
    return { kind, message, ...(detail ? { detail } : {}) };
  }
  if (kind === "warning" || kind === "guardianWarning") {
    if (detail || turnId || provider || phase || (kind === "guardianWarning" && !threadId))
      return undefined;
    return { kind, message, ...(threadId ? { threadId } : {}) };
  }
  if (
    kind !== "authRecovery" ||
    !threadId ||
    !turnId ||
    !provider ||
    detail ||
    (phase !== "started" && phase !== "completed")
  )
    return undefined;
  return { kind, message, threadId, turnId, provider, phase };
}
