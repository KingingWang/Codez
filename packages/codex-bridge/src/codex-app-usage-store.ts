import { statSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

export interface UsageEventSample extends TokenBreakdown {
  timestampMs: number;
  modelId: string | null;
}

export interface ThreadRow {
  id: string;
  model: string | null;
  tokensUsed: number;
  createdAtMs: number;
  updatedAtMs: number;
  rolloutPath: string;
}

export interface TurnRecord {
  threadId: string;
  startedAtMs: number;
  durationMs: number;
}

interface RolloutCacheEntry {
  mtimeMs: number;
  size: number;
  samples: UsageEventSample[];
  turnTimestampsMs: number[];
}

const ROLLOUT_PARSE_CACHE_LIMIT = 512;
const ROLLOUT_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ROLLOUT_STREAM_CHUNK_BYTES = 256 * 1024;
const rolloutParseCache = new Map<string, RolloutCacheEntry>();
const rolloutParseInFlight = new Map<
  string,
  Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null>
>();
let stateDbCache: { path: string; mtimeMs: number; size: number; rows: ThreadRow[] } | null = null;
let historyDbCache: { path: string; mtimeMs: number; size: number; rows: TurnRecord[] } | null =
  null;

function dbFileFingerprint(dbPath: string): { mtimeMs: number; size: number } | null {
  try {
    const main = statSync(dbPath);
    let mtimeMs = main.mtimeMs;
    let size = main.size;
    try {
      const wal = statSync(`${dbPath}-wal`);
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
      size += wal.size;
    } catch {
      // WAL 文件可不存在
    }
    return { mtimeMs, size };
  } catch {
    return null;
  }
}

function rememberRolloutParseCache(rolloutPath: string, entry: RolloutCacheEntry): void {
  rolloutParseCache.delete(rolloutPath);
  rolloutParseCache.set(rolloutPath, entry);
  if (rolloutParseCache.size > ROLLOUT_PARSE_CACHE_LIMIT) {
    rolloutParseCache.delete(rolloutParseCache.keys().next().value!);
  }
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveLatestSqliteFile(dir: string, prefix: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    let bestFile: string | null = null;
    let bestVersion = -1;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) continue;
      const versionPart = name.slice(prefix.length, -".sqlite".length);
      const version = Number.parseInt(versionPart, 10);
      if (Number.isFinite(version) && version > bestVersion) {
        bestVersion = version;
        bestFile = join(dir, name);
      }
    }
    return bestFile;
  } catch {
    return null;
  }
}

export function readThreadsFromStateDb(stateDbPath: string): ThreadRow[] {
  try {
    const fingerprint = dbFileFingerprint(stateDbPath);
    if (
      fingerprint &&
      stateDbCache &&
      stateDbCache.path === stateDbPath &&
      stateDbCache.mtimeMs === fingerprint.mtimeMs &&
      stateDbCache.size === fingerprint.size
    ) {
      return stateDbCache.rows;
    }
    const db = new DatabaseSync(stateDbPath, { open: true, readOnly: true });
    try {
      const rawRows = db
        .prepare(
          `SELECT id, model, tokens_used, created_at, created_at_ms, updated_at, updated_at_ms, rollout_path
           FROM threads`,
        )
        .all() as Array<Record<string, unknown>>;
      const rows = rawRows.map((row) => {
        const createdAtSec = nonNegInt(row.created_at);
        const updatedAtSec = nonNegInt(row.updated_at);
        const createdAtMs = nonNegInt(row.created_at_ms) || createdAtSec * 1000;
        const updatedAtMs = nonNegInt(row.updated_at_ms) || updatedAtSec * 1000 || createdAtMs;
        return {
          id: String(row.id ?? ""),
          model: normalizeModelId(row.model),
          tokensUsed: nonNegInt(row.tokens_used),
          createdAtMs,
          updatedAtMs,
          rolloutPath: typeof row.rollout_path === "string" ? row.rollout_path.trim() : "",
        };
      });
      if (fingerprint) {
        stateDbCache = {
          path: stateDbPath,
          mtimeMs: fingerprint.mtimeMs,
          size: fingerprint.size,
          rows,
        };
      }
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function readTurnsFromHistoryDb(historyDbPath: string): TurnRecord[] {
  try {
    const fingerprint = dbFileFingerprint(historyDbPath);
    if (
      fingerprint &&
      historyDbCache &&
      historyDbCache.path === historyDbPath &&
      historyDbCache.mtimeMs === fingerprint.mtimeMs &&
      historyDbCache.size === fingerprint.size
    ) {
      return historyDbCache.rows;
    }
    const db = new DatabaseSync(historyDbPath, { open: true, readOnly: true });
    try {
      const rawRows = db
        .prepare(
          `SELECT thread_id, started_at, completed_at, duration_ms
           FROM thread_turns`,
        )
        .all() as Array<Record<string, unknown>>;
      const rows = rawRows.map((row) => {
        const startedAtRaw = nonNegInt(row.started_at);
        const startedAtMs = startedAtRaw > 10_000_000_000 ? startedAtRaw : startedAtRaw * 1000;
        return {
          threadId: String(row.thread_id ?? ""),
          startedAtMs,
          durationMs: nonNegInt(row.duration_ms),
        };
      });
      if (fingerprint) {
        historyDbCache = {
          path: historyDbPath,
          mtimeMs: fingerprint.mtimeMs,
          size: fingerprint.size,
          rows,
        };
      }
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function parseRolloutUsage(
  rolloutPath: string,
  fallbackModel: string | null,
  fallbackTimestampMs: number,
): Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null> {
  if (!rolloutPath) return null;
  const inFlight = rolloutParseInFlight.get(rolloutPath);
  if (inFlight) return inFlight;
  const pending = parseRolloutUsageUncoalesced(
    rolloutPath,
    fallbackModel,
    fallbackTimestampMs,
  ).finally(() => {
    if (rolloutParseInFlight.get(rolloutPath) === pending) {
      rolloutParseInFlight.delete(rolloutPath);
    }
  });
  rolloutParseInFlight.set(rolloutPath, pending);
  return pending;
}

async function parseRolloutUsageUncoalesced(
  rolloutPath: string,
  fallbackModel: string | null,
  fallbackTimestampMs: number,
): Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(rolloutPath);
    if (!fileStat.isFile()) return null;
  } catch {
    return null;
  }
  const cached = rolloutParseCache.get(rolloutPath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    rememberRolloutParseCache(rolloutPath, cached);
    return { samples: cached.samples, turnTimestampsMs: cached.turnTimestampsMs };
  }

  const samples: UsageEventSample[] = [];
  const turnTimestampsMs: number[] = [];
  let currentModel = fallbackModel;
  let prevTotal: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cacheCreation: number;
    cacheRead: number;
  } | null = null;

  const consumeLine = (line: string): void => {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const parsedTs =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      const timestampMs =
        Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : fallbackTimestampMs;
      if (parsed.type === "turn_context") {
        const payload = asRecord(parsed.payload);
        const collabSettings = asRecord(asRecord(payload.collaboration_mode).settings);
        const turnModel = normalizeModelId(payload.model) ?? normalizeModelId(collabSettings.model);
        if (turnModel) currentModel = turnModel;
        turnTimestampsMs.push(timestampMs);
        return;
      }
      if (parsed.type === "event_msg") {
        const payload = asRecord(parsed.payload);
        if (payload.type !== "token_count") return;
        const info = asRecord(payload.info);
        const totalObj = asRecord(info.total_token_usage);
        const lastObj = asRecord(info.last_token_usage);
        const totalVal = nonNegInt(totalObj.total_tokens);
        const inputVal = nonNegInt(totalObj.input_tokens);
        const outputVal = nonNegInt(totalObj.output_tokens);
        const reasoningVal = nonNegInt(totalObj.reasoning_output_tokens);
        const cacheCreationVal = nonNegInt(totalObj.cache_write_input_tokens);
        const cacheReadVal = nonNegInt(totalObj.cached_input_tokens);

        if (totalVal > 0) {
          if (!prevTotal) {
            const lastTotal = nonNegInt(lastObj.total_tokens);
            const useLast = lastTotal > 0 && lastTotal <= totalVal;
            const deltaTotal = useLast ? lastTotal : totalVal;
            const deltaInput = useLast ? nonNegInt(lastObj.input_tokens) : inputVal;
            const deltaOutput = useLast ? nonNegInt(lastObj.output_tokens) : outputVal;
            const deltaReasoning = useLast
              ? nonNegInt(lastObj.reasoning_output_tokens)
              : reasoningVal;
            const deltaCacheCreation = useLast
              ? nonNegInt(lastObj.cache_write_input_tokens)
              : cacheCreationVal;
            const deltaCacheRead = useLast ? nonNegInt(lastObj.cached_input_tokens) : cacheReadVal;
            prevTotal = {
              total: totalVal,
              input: inputVal,
              output: outputVal,
              reasoning: reasoningVal,
              cacheCreation: cacheCreationVal,
              cacheRead: cacheReadVal,
            };
            if (deltaTotal > 0) {
              samples.push({
                timestampMs,
                modelId: currentModel ?? fallbackModel,
                totalTokens: deltaTotal,
                inputTokens: deltaInput,
                outputTokens: deltaOutput,
                reasoningTokens: deltaReasoning,
                cacheCreationTokens: deltaCacheCreation,
                cacheReadTokens: deltaCacheRead,
                requestCount: 1,
              });
            }
          } else if (totalVal > prevTotal.total) {
            const deltaTotal = totalVal - prevTotal.total;
            const deltaInput = Math.max(0, inputVal - prevTotal.input);
            const deltaOutput = Math.max(0, outputVal - prevTotal.output);
            const deltaReasoning = Math.max(0, reasoningVal - prevTotal.reasoning);
            const deltaCacheCreation = Math.max(0, cacheCreationVal - prevTotal.cacheCreation);
            const deltaCacheRead = Math.max(0, cacheReadVal - prevTotal.cacheRead);
            prevTotal = {
              total: totalVal,
              input: inputVal,
              output: outputVal,
              reasoning: reasoningVal,
              cacheCreation: cacheCreationVal,
              cacheRead: cacheReadVal,
            };
            samples.push({
              timestampMs,
              modelId: currentModel ?? fallbackModel,
              totalTokens: deltaTotal,
              inputTokens: deltaInput,
              outputTokens: deltaOutput,
              reasoningTokens: deltaReasoning,
              cacheCreationTokens: deltaCacheCreation,
              cacheReadTokens: deltaCacheRead,
              requestCount: 1,
            });
          }
        } else {
          const lastTotal = nonNegInt(lastObj.total_tokens);
          if (lastTotal > 0) {
            samples.push({
              timestampMs,
              modelId: currentModel ?? fallbackModel,
              totalTokens: lastTotal,
              inputTokens: nonNegInt(lastObj.input_tokens),
              outputTokens: nonNegInt(lastObj.output_tokens),
              reasoningTokens: nonNegInt(lastObj.reasoning_output_tokens),
              cacheCreationTokens: nonNegInt(lastObj.cache_write_input_tokens),
              cacheReadTokens: nonNegInt(lastObj.cached_input_tokens),
              requestCount: 1,
            });
          }
        }
      }
    } catch {
      // 忽略截断或非 JSON 行
    }
  };

  const consumeChunkText = (chunk: string): void => {
    let pos = 0;
    while (pos < chunk.length) {
      let next = chunk.indexOf("\n", pos);
      if (next === -1) next = chunk.length;
      consumeLine(chunk.slice(pos, next));
      pos = next + 1;
    }
  };

  if (fileStat.size <= ROLLOUT_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await readFile(rolloutPath, "utf8");
    } catch {
      return null;
    }
    consumeChunkText(content);
  } else {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(rolloutPath, "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.allocUnsafe(ROLLOUT_STREAM_CHUNK_BYTES);
      const decoder = new StringDecoder("utf8");
      let remainder = "";
      let offset = 0;
      while (offset < fileStat.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1) {
          remainder = text;
          continue;
        }
        consumeChunkText(text.slice(0, lastNewline));
        remainder = text.slice(lastNewline + 1);
      }
      const tail = remainder + decoder.end();
      if (tail) consumeChunkText(tail);
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  rememberRolloutParseCache(rolloutPath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    samples,
    turnTimestampsMs,
  });
  return { samples, turnTimestampsMs };
}
