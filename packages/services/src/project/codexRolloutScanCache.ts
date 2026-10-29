import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ParsedRolloutCandidate } from "#src/project/codexRolloutFacts.js";

const logger = createServiceLogger("codex-rollout-scan-cache");

/** 结构版本：字段增删必须递增；旧文件按不可读处理，fail-open 回全量解析。 */
const SCAN_CACHE_VERSION = 2;
/**
 * 条目上限：超出即整份不落盘。
 * 原因：缓存内容随历史会话数线性增长，无上限会把「启动少解析」换成「每轮重写一份无界 JSON」。
 * 超限只损失加速效果，不影响正确性（下一轮启动照常全量解析）。
 */
const SCAN_CACHE_MAX_ENTRIES = 20_000;

const candidateSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  forkedFromTaskId: z.string().optional(),
  originProjectId: z.string().nullable().optional(),
  lastOutcome: z.enum(["completed", "interrupted", "error"]).optional(),
});

const entrySchema = z.object({
  path: z.string().min(1),
  mtimeMs: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
  settled: z.boolean(),
  candidate: candidateSchema.nullable(),
});

const cacheFileSchema = z.object({
  version: z.literal(SCAN_CACHE_VERSION),
  codexHome: z.string().min(1),
  entries: z.array(entrySchema),
});

/**
 * 单个 rollout 的「解析事实」：只描述文件内容，不描述入库状态。
 *
 * 这里刻意没有 `synced` 字段。`synced` 的含义是「事实已写入当前 Host 的 tasks-index 分区」，
 * 一旦持久化，缓存与 SQLite 就变成两个没有事务约束的权威副本：缓存说已入库而库里没有该行时
 * （任务在 Codez 里被删、库重建或迁移、身份解析规则变化、缓存文件被复制到另一台机器），
 * `consider()` 会永久跳过这个文件，会话再也不会出现在侧栏，且除了删缓存文件没有任何自愈路径
 * ——正是 issue #19/#24 的故障类。因此入库状态始终由 tasks-index 现场判定。
 *
 * 也正因为只存文件派生事实，缓存与 Host 无关：同一 `$CODEX_HOME` 下的多个窗口/Host
 * 可以安全共用同一份文件（写入走 `atomicWriteText` 的跨进程文件锁）。
 */
export interface RolloutScanFacts {
  mtimeMs: number;
  size: number;
  candidate: ParsedRolloutCandidate | null;
  settled: boolean;
}

/**
 * 读取解析事实缓存。任何失败（文件不存在、JSON 损坏、版本不符、结构非法、
 * `$CODEX_HOME` 作用域不符、路径不属于该 home）都返回空表并回退到今天的全量解析，
 * 绝不抛错、绝不跳过会话。
 */
export async function loadRolloutScanFacts(
  filePath: string,
  codexHome: string,
): Promise<Map<string, RolloutScanFacts>> {
  const facts = new Map<string, RolloutScanFacts>();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // 首次启动或缓存被清理属于正常路径，不告警。
    return facts;
  }
  try {
    const parsed = cacheFileSchema.parse(JSON.parse(raw));
    if (parsed.codexHome !== codexHome) {
      // $CODEX_HOME 切换（含 CI / native smoke 每次覆盖）后，缓存里的绝对路径属于另一个
      // profile；整份丢弃，避免把别的 home 的会话事实写进当前 Host 的 tasks-index。
      logger.warn("Codex rollout 解析事实缓存作用域不匹配，回退全量解析", { codexHome });
      return facts;
    }
    for (const entry of parsed.entries) {
      if (!entry.path.startsWith(codexHome)) continue;
      facts.set(entry.path, {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        candidate: entry.candidate,
        settled: entry.settled,
      });
    }
  } catch (error) {
    logger.warn("Codex rollout 解析事实缓存不可用，回退全量解析", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return facts;
}

/** 序列化待落盘内容；超过条目上限时返回 undefined，调用方跳过本轮写入。 */
export function serializeRolloutScanFacts(
  codexHome: string,
  entries: Iterable<readonly [string, RolloutScanFacts]>,
): string | undefined {
  const rows: z.infer<typeof entrySchema>[] = [];
  for (const [path, facts] of entries) {
    rows.push({
      path,
      mtimeMs: facts.mtimeMs,
      size: facts.size,
      settled: facts.settled,
      candidate: facts.candidate,
    });
    if (rows.length > SCAN_CACHE_MAX_ENTRIES) return undefined;
  }
  return JSON.stringify({ version: SCAN_CACHE_VERSION, codexHome, entries: rows });
}

/** 原子落盘（同目录临时文件 + rename + 跨进程文件锁），读者永远看不到半份内容。 */
export async function saveRolloutScanFacts(filePath: string, content: string): Promise<void> {
  await atomicWriteText(filePath, content);
}
