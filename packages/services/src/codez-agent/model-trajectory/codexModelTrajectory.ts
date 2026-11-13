import { readdir, open, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CodezModelTrajectory,
  CodezModelTrajectoryContentPart,
  CodezModelTrajectoryMessage,
  CodezModelTrajectoryRecord,
} from "@codez/services";
import { isInjectedCodexContextTitle } from "@codez/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readTrajectoryFileTail } from "../modelTrajectoryFileTail.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const logger = createServiceLogger("codex-model-trajectory");
const MAX_SESSION_DIRS = 512;
const MAX_SESSION_FILES = 4096;
const MAX_ROLLOUT_RECORDS = 200;

/**
 * Codex 以 user 角色落盘、但不是用户输入的机器生成信封：注入环境块与续跑上下文。
 * 实测同一 `<environment_context>` 信封既有 `<cwd>` 开头也有 `<current_date>` 开头的变体，
 * 因此这里按信封名匹配；`# AGENTS.md instructions …` 片段复用 shared 的单一谓词，
 * 不在本模块另写一份正则。
 */
const CODEX_INJECTED_USER_ENVELOPE = /^<(?:environment_context|codex_internal_context)[\s>]/u;

/**
 * 判断一条 user 角色 response_item 是否真的是用户输入。
 *
 * 修复原因（issue #35）：旧门槛要求 `metadata.client_authored === true`，但现行 Codex build
 * 的 user response_item 根本不写 metadata 键（实测 400 份 rollout、1277 条 user 消息全部缺失），
 * 于是真实用户输入被全部过滤，`request.messages` 恒为空，UI 因 `hasInput=false`
 * 整块不渲染「输入」section。metadata 存在时仍按原生事实判定；缺失时只排除已知注入信封。
 */
function isUserAuthoredInput(payload: Record<string, unknown>, text: string): boolean {
  const metadata = asObject(payload.metadata);
  if (metadata) return metadata.client_authored === true;
  const normalized = text.trimStart();
  return !isInjectedCodexContextTitle(normalized) && !CODEX_INJECTED_USER_ENVELOPE.test(normalized);
}

type ToolCallDraft = Extract<CodezModelTrajectoryRecord["response"], object>["toolCalls"][number] &
  Extract<CodezModelTrajectoryContentPart, { kind: "tool-call" }> & {
    output?: unknown;
  };

interface UsageDraft {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

interface TurnDraft {
  requestId: string;
  turnId?: string;
  startedAt: string;
  completedAt?: string;
  modelId?: string;
  /** Codex 把系统指令以 developer（部分 build 为 system）角色落盘，投影成 system 行。 */
  systemMessages: CodezModelTrajectoryMessage[];
  userMessages: CodezModelTrajectoryMessage[];
  assistantTexts: string[];
  reasoningTexts: string[];
  toolCalls: ToolCallDraft[];
  usage: UsageDraft;
  totalUsage?: UsageDraft;
  finishReason?: string;
  durationMs?: number;
  error?: { name: string; message: string; stack?: string };
}

/**
 * 解析 Codex rollout 的 per-turn 投影。Codex 不落原始 API request，这里不伪造完整上下文，
 * 只把该 turn 的用户输入、assistant 输出、工具调用和 token 事件投影成 UI 可读记录。
 */
export async function readCodexModelTrajectory(
  taskId: string,
  limit = MAX_ROLLOUT_RECORDS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodezModelTrajectory> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : MAX_ROLLOUT_RECORDS;
  const rolloutPath = await resolveCodexRolloutPath(taskId, env);
  if (!rolloutPath) return emptyTrajectory(taskId);

  const readStartedAt = Date.now();
  const firstLine = await readRolloutFirstLine(rolloutPath);
  if (!rolloutMatchesTask(firstLine, taskId)) return emptyTrajectory(taskId);
  const tail = await readTrajectoryFileTail(rolloutPath);
  const records = parseCodexRolloutLines(taskId, tail.text.split("\n"));
  const truncated = tail.truncated || records.length > safeLimit;
  const result: CodezModelTrajectory = {
    taskId,
    available: true,
    records: truncated ? records.slice(records.length - safeLimit) : records,
    sourceFiles: [rolloutPath],
    truncated,
  };
  logger.debug(
    undefined,
    `read taskId=${taskId} bytes=${tail.bytesRead} records=${result.records.length} truncated=${truncated} durationMs=${Date.now() - readStartedAt}`,
  );
  return result;
}

function emptyTrajectory(taskId: string): CodezModelTrajectory {
  return {
    taskId,
    available: true,
    records: [],
    sourceFiles: [],
    truncated: false,
  };
}

async function resolveCodexRolloutPath(
  taskId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const indexed = await resolveRolloutFromStateDb(codexHome, taskId);
  return indexed ?? scanSessionRolloutPath(join(codexHome, "sessions"), taskId);
}

async function resolveRolloutFromStateDb(
  codexHome: string,
  taskId: string,
): Promise<string | null> {
  let stateDbPath: string | null = null;
  try {
    const names = await readdir(codexHome);
    let bestVersion = -1;
    for (const name of names) {
      if (!name.startsWith("state_") || !name.endsWith(".sqlite")) continue;
      const version = Number.parseInt(name.slice(6, -".sqlite".length), 10);
      if (Number.isFinite(version) && version > bestVersion) {
        bestVersion = version;
        stateDbPath = join(codexHome, name);
      }
    }
  } catch {
    return null;
  }
  if (!stateDbPath) return null;

  try {
    const db = new DatabaseSync(stateDbPath, { open: true, readOnly: true });
    try {
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(taskId) as
        | { rollout_path?: unknown }
        | undefined;
      const path = typeof row?.rollout_path === "string" ? row.rollout_path.trim() : "";
      if (!path) return null;
      const fileInfo = await stat(path);
      return fileInfo.isFile() ? path : null;
    } finally {
      db.close();
    }
  } catch (error) {
    logger.debug(undefined, `state db lookup failed taskId=${taskId}`, error);
    return null;
  }
}

async function scanSessionRolloutPath(root: string, taskId: string): Promise<string | null> {
  const suffix = `-${taskId}.jsonl`;
  const directories = [root];
  let visitedDirs = 0;
  let visitedFiles = 0;
  while (
    directories.length > 0 &&
    visitedDirs < MAX_SESSION_DIRS &&
    visitedFiles < MAX_SESSION_FILES
  ) {
    const directory = directories.shift()!;
    visitedDirs += 1;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visitedFiles += 1;
      if (visitedFiles >= MAX_SESSION_FILES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return path;
    }
  }
  return null;
}

async function readRolloutFirstLine(path: string): Promise<Record<string, unknown> | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, result.bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    const line = (newline === -1 ? text : text.slice(0, newline)).trim();
    if (!line) return null;
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function rolloutMatchesTask(firstLine: Record<string, unknown> | null, taskId: string): boolean {
  if (!firstLine || firstLine.type !== "session_meta") return false;
  return asObject(firstLine.payload)?.id === taskId;
}

export function parseCodexRolloutLines(
  taskId: string,
  lines: readonly string[],
): CodezModelTrajectoryRecord[] {
  const turns: TurnDraft[] = [];
  const currentRef: { draft: TurnDraft | null } = { draft: null };
  const startTurn = (draft: TurnDraft): void => {
    if (currentRef.draft) {
      currentRef.draft.completedAt ??= draft.startedAt;
      turns.push(currentRef.draft);
    }
    currentRef.draft = draft;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = asString(line.timestamp) ?? "";
    const payload = asObject(line.payload) ?? {};

    if (line.type === "turn_context") {
      const turnId = asString(payload.turn_id);
      startTurn({
        requestId: turnId ? `codex-${turnId}` : `codex-${turns.length + 1}`,
        turnId,
        startedAt: timestamp,
        modelId: asString(payload.model) ?? modelFromCollaboration(payload.collaboration_mode),
        systemMessages: [],
        userMessages: [],
        assistantTexts: [],
        reasoningTexts: [],
        toolCalls: [],
        usage: emptyUsage(),
        // 没有 last_token_usage 时，下一 turn 需要拿上一 turn 的累计值做差分。
        totalUsage: currentRef.draft?.totalUsage ? { ...currentRef.draft.totalUsage } : undefined,
      });
      continue;
    }
    const currentTurn = currentRef.draft;
    if (!currentTurn) continue;
    currentTurn.completedAt = timestamp || currentTurn.completedAt;

    if (
      line.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "user" &&
      // 与 acceptMessageItem 用同一判定：否则 metadata 缺失时既不收消息也不切记录，
      // 长会话（只落一个 turn_context）会被合成一条巨型 record。
      isUserAuthoredInput(payload, messageText(payload.content) ?? "") &&
      currentTurn.userMessages.length > 0
    ) {
      // Codex rollout 有时整个长会话只落一个 turn_context；新的 user message 仍是新的
      // 模型调用边界，这里开启下一条 projected record，避免把全天内容合成一条记录。
      startTurn({
        requestId: currentTurn.turnId
          ? `codex-${currentTurn.turnId}-${currentTurn.userMessages.length + 1}`
          : `codex-${turns.length + 1}`,
        turnId: currentTurn.turnId,
        startedAt: timestamp,
        modelId: currentTurn.modelId,
        usage: emptyUsage(),
        totalUsage: currentTurn.totalUsage ? { ...currentTurn.totalUsage } : undefined,
        systemMessages: [],
        userMessages: [],
        assistantTexts: [],
        reasoningTexts: [],
        toolCalls: [],
      });
    }

    if (line.type === "response_item") {
      const responseTurn = currentRef.draft ?? currentTurn;
      acceptResponseItem(responseTurn, payload);
    } else if (line.type === "event_msg") acceptEventItem(currentTurn, payload);
  }
  if (currentRef.draft) turns.push(currentRef.draft);

  return turns
    .filter(hasTurnSignal)
    .map((turn) => mapTurn(taskId, turn))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function emptyUsage(): UsageDraft {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
}

function acceptResponseItem(turn: TurnDraft, payload: Record<string, unknown>): void {
  if (payload.type === "message") acceptMessageItem(turn, payload);
  else if (payload.type === "reasoning") acceptReasoningItem(turn, payload);
  else if (
    payload.type === "function_call" ||
    payload.type === "custom_tool_call" ||
    payload.type === "local_shell_call"
  ) {
    acceptToolCall(turn, payload);
  } else if (
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output" ||
    payload.type === "local_shell_call_output"
  ) {
    acceptToolOutput(turn, payload);
  }
  // 未知 response_item 保持跳过，避免 Codex 新事件类型破坏整个轨迹读取。
}

function acceptMessageItem(turn: TurnDraft, payload: Record<string, unknown>): void {
  const text = messageText(payload.content);
  if (!text) return;
  if (payload.role === "user") {
    // subagent/notification 等 internal user item 不是用户发起的模型调用边界，
    // 不能混入 request.messages；判定依据见 isUserAuthoredInput。
    if (isUserAuthoredInput(payload, text)) {
      turn.userMessages.push({ role: "user", parts: [{ kind: "text", text }] });
    }
    return;
  }
  if (payload.role === "assistant") {
    turn.assistantTexts.push(text);
    return;
  }
  // 修复原因（issue #35）：Codex 把系统指令以 developer 角色落盘（部分 build 用 system），
  // 旧实现只认 user/assistant，系统提示词从不投影，UI 的「系统提示词」开关在 Codex 会话下
  // 永远为空。统一按 system 角色投影，与 Codez Agent model-io 链路的六类行对齐。
  if (payload.role === "developer" || payload.role === "system") {
    turn.systemMessages.push({ role: "system", parts: [{ kind: "text", text }] });
  }
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return textOrUndefined(value);
  if (!Array.isArray(value)) return undefined;
  return (
    value
      .map((entry) => {
        const part = asObject(entry);
        const text = asString(part?.text);
        return part?.type === "input_text" || part?.type === "output_text" ? text : undefined;
      })
      .filter((text): text is string => text !== undefined)
      .join("\n") || undefined
  );
}

function acceptReasoningItem(turn: TurnDraft, payload: Record<string, unknown>): void {
  const texts = Array.isArray(payload.summary)
    ? payload.summary
        .map((entry) => asString(asObject(entry)?.text))
        .filter((text): text is string => text !== undefined)
    : [];
  const text = texts.join("\n");
  if (text) turn.reasoningTexts.push(text);
}

function acceptToolCall(turn: TurnDraft, payload: Record<string, unknown>): void {
  turn.toolCalls.push({
    kind: "tool-call",
    toolCallId: asString(payload.call_id) ?? asString(payload.id),
    toolName:
      asString(payload.name) ?? (payload.type === "local_shell_call" ? "local_shell" : "tool"),
    input: parseJsonObjectOrRaw(asString(payload.arguments) ?? payload.input),
  });
}

function acceptToolOutput(turn: TurnDraft, payload: Record<string, unknown>): void {
  const callId = asString(payload.call_id) ?? asString(payload.id);
  const call = [...turn.toolCalls].reverse().find((candidate) => candidate.toolCallId === callId);
  if (!call) return;
  call.output = payload.output ?? payload.result;
  // UI 以 output 的存在性展示工具结果；错误 output 的内容自身会携带错误上下文。
}

function acceptEventItem(turn: TurnDraft, payload: Record<string, unknown>): void {
  if (payload.type === "token_count") {
    const modelId = asString(payload.model);
    if (modelId) turn.modelId = modelId;
    acceptTokenCount(turn, asObject(payload.info));
  } else if (payload.type === "task_complete") {
    turn.finishReason = "stop";
    const completedAt = nonNegativeInteger(payload.completed_at);
    if (completedAt !== undefined) {
      turn.completedAt = new Date(completedAt * 1000).toISOString();
    }
    if (typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)) {
      turn.durationMs = Math.max(0, Math.trunc(payload.duration_ms));
    }
  } else if (payload.type === "turn_aborted" || payload.type === "error") {
    turn.finishReason = "error";
    turn.error = normalizeError(payload);
  }
}

function acceptTokenCount(turn: TurnDraft, info: Record<string, unknown> | undefined): void {
  if (!info) return;
  const last = normalizeUsage(info.last_token_usage);
  if (last) addUsage(turn.usage, last);
  const total = normalizeUsage(info.total_token_usage);
  if (!total) return;
  if (last) {
    // last_token_usage 已经是本次调用增量；total 只作为后续缺失 last 时的累计基线。
  } else if (turn.totalUsage !== undefined) {
    addUsage(turn.usage, {
      inputTokens: Math.max(0, total.inputTokens - turn.totalUsage.inputTokens),
      outputTokens: Math.max(0, total.outputTokens - turn.totalUsage.outputTokens),
      totalTokens: Math.max(0, total.totalTokens - turn.totalUsage.totalTokens),
      cacheReadTokens: Math.max(0, total.cacheReadTokens - turn.totalUsage.cacheReadTokens),
      reasoningTokens: Math.max(0, total.reasoningTokens - turn.totalUsage.reasoningTokens),
    });
  } else {
    addUsage(turn.usage, total);
  }
  turn.totalUsage = total;
}

function addUsage(target: UsageDraft, delta: UsageDraft): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.totalTokens += delta.totalTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.reasoningTokens += delta.reasoningTokens;
}

function normalizeUsage(value: unknown): UsageDraft | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const totalTokens = nonNegativeInteger(usage.total_tokens);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens: nonNegativeInteger(usage.input_tokens) ?? 0,
    outputTokens: nonNegativeInteger(usage.output_tokens) ?? 0,
    totalTokens,
    cacheReadTokens: nonNegativeInteger(usage.cached_input_tokens) ?? 0,
    reasoningTokens: nonNegativeInteger(usage.reasoning_output_tokens) ?? 0,
  };
}

function normalizeError(payload: Record<string, unknown>): TurnDraft["error"] {
  const error = asObject(payload.error);
  return {
    name: asString(error?.type) ?? asString(error?.code) ?? "CodexTurnError",
    message: asString(error?.message) ?? asString(payload.message) ?? "Codex turn failed",
    stack: asString(error?.stack),
  };
}

function hasTurnSignal(turn: TurnDraft): boolean {
  return (
    turn.userMessages.length > 0 ||
    turn.assistantTexts.length > 0 ||
    turn.reasoningTexts.length > 0 ||
    turn.toolCalls.length > 0 ||
    turn.usage.totalTokens > 0 ||
    turn.error !== undefined
  );
}

/**
 * 把内部 tool-call 草稿投影成公开 part。
 *
 * 修复原因（issue #35）：契约里 `tool-call` 只有 `input`，没有 `output`；旧实现把
 * `function_call_output` 挂在草稿的 output 上并原样交给 UI，而 UI 的 ContentPartView
 * 在 tool-call 分支只渲染 input，于是 Codex 会话的工具结果永远不可见。这里改为
 * 追加独立的 `tool-result` part，复用 UI 既有的 tool-result 分支（与 Codez Agent 链路同形），
 * 同时不再把契约外的 output 字段泄漏到 tool-call part 上。
 */
function projectToolParts(calls: ToolCallDraft[]): CodezModelTrajectoryContentPart[] {
  const parts: CodezModelTrajectoryContentPart[] = [];
  for (const call of calls) {
    parts.push({
      kind: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
    // output 缺失表示该调用没有落 function_call_output（例如轮次被中断），不伪造空结果。
    if (call.output === undefined) continue;
    parts.push({
      kind: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: call.output,
    });
  }
  return parts;
}

function mapTurn(taskId: string, turn: TurnDraft): CodezModelTrajectoryRecord {
  const completedTime = Date.parse(turn.completedAt ?? "");
  const startedTime = Date.parse(turn.startedAt);
  const derivedDuration =
    Number.isFinite(completedTime) && Number.isFinite(startedTime)
      ? Math.max(0, completedTime - startedTime)
      : undefined;
  return {
    provider: "codex",
    requestId: turn.requestId || `codex-${taskId}`,
    attempt: 1,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs ?? derivedDuration,
    turnId: turn.turnId,
    callSource: { kind: "sidecar", querySource: "codex_rollout" },
    model: {
      modelId: turn.modelId,
      providerId: "codex",
      source: "codex-rollout",
    },
    // 系统提示词在前、用户输入在后，与模型实际收到的顺序一致。Codex record 的
    // callSource.kind 是 sidecar，UI 不做会话 delta 裁剪，因此每条 record 完整展示。
    request: { messages: [...turn.systemMessages, ...turn.userMessages], toolNames: [] },
    response: {
      finishReason: turn.finishReason ?? (turn.toolCalls.length > 0 ? "tool_calls" : "stop"),
      text: turn.assistantTexts.join("\n") || undefined,
      reasoningText: turn.reasoningTexts.join("\n\n") || undefined,
      toolCalls: projectToolParts(turn.toolCalls),
      usage: turn.usage,
    },
    ...(turn.error ? { error: turn.error } : {}),
  };
}

function modelFromCollaboration(value: unknown): string | undefined {
  return asString(asObject(asObject(value)?.settings)?.model);
}

function parseJsonObjectOrRaw(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textOrUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
