import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryCodexAppUsageStats } from "../src/codex-app-usage.js";
import { readUsageStoreCounters, type UsageStoreCounters } from "../src/codex-app-usage-store.js";

const DAY_MS = 86_400_000;
// 大历史库基准数据：近窗线程与历史线程的 token 数固定，便于直接算出期望值
const RECENT_TOKENS_EACH = 100;
const OLD_TOKENS_EACH = 500;
/** 历史线程 rollout 里的「毒样本」token 数：一旦被读到，7d/30d 总数会立刻爆掉 */
const POISON_TOKENS_EACH = 999_999;
const OLD_THREAD_AGE_MS = 400 * DAY_MS;
const TURN_DURATION_MS = 60_000;
/** usage 查询期间允许的 bridge event-loop lag 上限 */
const EVENT_LOOP_LAG_BUDGET_MS = 60;

async function createFixtureCodexHome(now: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-app-usage-"));
  const rolloutDir = join(root, "sessions", "2026", "10", "18");
  await mkdir(rolloutDir, { recursive: true });

  const rolloutAlphaPath = join(rolloutDir, "rollout-thread-alpha.jsonl");
  const day1Iso = new Date(now - DAY_MS).toISOString();
  const day2Iso = new Date(now - 2 * DAY_MS).toISOString();

  // Thread alpha: 2 turns across 2 days, switching models from gpt-5.4 to gemini-4-argon
  const rolloutLines = [
    JSON.stringify({
      timestamp: day2Iso,
      ordinal: 1,
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.4",
      },
    }),
    JSON.stringify({
      timestamp: day2Iso,
      ordinal: 2,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            cache_write_input_tokens: 0,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            cache_write_input_tokens: 0,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: day1Iso,
      ordinal: 3,
      type: "turn_context",
      payload: {
        turn_id: "turn-2",
        model: "gemini-4-argon",
      },
    }),
    JSON.stringify({
      timestamp: day1Iso,
      ordinal: 4,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 3000,
            cached_input_tokens: 1400,
            cache_write_input_tokens: 0,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 3500,
          },
          last_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1000,
            cache_write_input_tokens: 0,
            output_tokens: 300,
            reasoning_output_tokens: 50,
            total_tokens: 2300,
          },
        },
      },
    }),
  ];
  await writeFile(rolloutAlphaPath, `${rolloutLines.join("\n")}\n`, "utf8");

  const stateDb = new DatabaseSync(join(root, "state_5.sqlite"));
  try {
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        model TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insertThread = stateDb.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, model, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Thread 1 with rollout file
    insertThread.run(
      "thread-alpha",
      rolloutAlphaPath,
      Math.trunc((now - 2 * DAY_MS) / 1000),
      now - 2 * DAY_MS,
      Math.trunc((now - DAY_MS) / 1000),
      now - DAY_MS,
      "gemini-4-argon",
      3500,
    );
    // Thread 2 without rollout file (archived/cleaned), 15 days ago
    insertThread.run(
      "thread-legacy",
      join(rolloutDir, "missing-rollout.jsonl"),
      Math.trunc((now - 15 * DAY_MS) / 1000),
      now - 15 * DAY_MS,
      Math.trunc((now - 15 * DAY_MS) / 1000),
      now - 15 * DAY_MS,
      "claude-opus-5",
      5000,
    );
  } finally {
    stateDb.close();
  }

  const historyDb = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  try {
    historyDb.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
    const insertTurn = historyDb.prepare(`
      INSERT INTO thread_turns (thread_id, turn_id, started_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertTurn.run(
      "thread-alpha",
      "turn-1",
      Math.trunc((now - 2 * DAY_MS) / 1000),
      Math.trunc((now - 2 * DAY_MS) / 1000) + 120,
      120_000,
    );
    insertTurn.run(
      "thread-alpha",
      "turn-2",
      Math.trunc((now - DAY_MS) / 1000),
      Math.trunc((now - DAY_MS) / 1000) + 180,
      180_000,
    );
  } finally {
    historyDb.close();
  }

  return root;
}

interface BulkFixtureOptions {
  now: number;
  oldThreadCount: number;
  /** 近窗线程的天龄列表，决定 7d / 30d 各自应命中多少个线程 */
  recentAgesDays: number[];
  /** 以 WAL 模式建库：写入只落 `-wal`，用于验证 WAL 指纹同样会让缓存失效 */
  wal?: boolean;
}

interface BulkFixture {
  root: string;
  env: { CODEX_HOME: string };
  stateDbPath: string;
  historyDbPath: string;
  oldThreadCount: number;
  recentAgesDays: number[];
}

interface ThreadSeed {
  id: string;
  rolloutPath: string;
  createdAtMs: number;
  updatedAtMs: number;
  model: string;
  tokensUsed: number;
  rolloutIso: string;
  rolloutTokens: number;
}

function rolloutContent(iso: string, model: string, totalTokens: number): string {
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return [
    JSON.stringify({ timestamp: iso, type: "turn_context", payload: { turn_id: "turn-1", model } }),
    JSON.stringify({
      timestamp: iso,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    }),
    "",
  ].join("\n");
}

/**
 * 构造「大历史库」fixture：`oldThreadCount` 个 400 天前的历史线程 + 若干近窗线程。
 * 历史线程的 rollout 内容时间戳故意落在近窗内（毒样本），因此只要时间窗没有在 DB 层生效、
 * 历史线程被误选中读了 rollout，7d/30d 的总数就会立刻暴露问题。
 */
async function createBulkFixtureCodexHome(options: BulkFixtureOptions): Promise<BulkFixture> {
  const { now, oldThreadCount, recentAgesDays } = options;
  const root = await mkdtemp(join(tmpdir(), "codex-app-usage-bulk-"));
  const rolloutDir = join(root, "sessions", "2026", "10", "18");
  await mkdir(rolloutDir, { recursive: true });

  const seeds: ThreadSeed[] = recentAgesDays.map((ageDays, index) => {
    const ts = now - ageDays * DAY_MS;
    return {
      id: `recent-${index}`,
      rolloutPath: join(rolloutDir, `rollout-recent-${index}.jsonl`),
      createdAtMs: ts,
      updatedAtMs: ts,
      model: "gpt-5.4",
      tokensUsed: RECENT_TOKENS_EACH,
      rolloutIso: new Date(ts).toISOString(),
      rolloutTokens: RECENT_TOKENS_EACH,
    };
  });
  for (let index = 0; index < oldThreadCount; index += 1) {
    const ts = now - OLD_THREAD_AGE_MS;
    seeds.push({
      id: `old-${index}`,
      rolloutPath: join(rolloutDir, `rollout-old-${index}.jsonl`),
      createdAtMs: ts,
      updatedAtMs: ts,
      model: "claude-opus-5",
      tokensUsed: OLD_TOKENS_EACH,
      rolloutIso: new Date(now - DAY_MS).toISOString(),
      rolloutTokens: POISON_TOKENS_EACH,
    });
  }

  // 有界并发写文件：上千个小文件串行写会把测试自身变成瓶颈
  let nextSeed = 0;
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (nextSeed < seeds.length) {
        const seed = seeds[nextSeed++]!;
        await writeFile(
          seed.rolloutPath,
          rolloutContent(seed.rolloutIso, seed.model, seed.rolloutTokens),
          "utf8",
        );
      }
    }),
  );

  const stateDbPath = join(root, "state_5.sqlite");
  const historyDbPath = join(root, "thread_history_1.sqlite");
  const stateDb = new DatabaseSync(stateDbPath);
  try {
    if (options.wal) stateDb.exec("PRAGMA journal_mode = WAL");
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        model TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insertThread = stateDb.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, model, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stateDb.exec("BEGIN");
    for (const seed of seeds) {
      insertThread.run(
        seed.id,
        seed.rolloutPath,
        Math.trunc(seed.createdAtMs / 1000),
        seed.createdAtMs,
        Math.trunc(seed.updatedAtMs / 1000),
        seed.updatedAtMs,
        seed.model,
        seed.tokensUsed,
      );
    }
    stateDb.exec("COMMIT");
  } finally {
    stateDb.close();
  }

  const historyDb = new DatabaseSync(historyDbPath);
  try {
    if (options.wal) historyDb.exec("PRAGMA journal_mode = WAL");
    historyDb.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
    const insertTurn = historyDb.prepare(`
      INSERT INTO thread_turns (thread_id, turn_id, started_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    historyDb.exec("BEGIN");
    seeds.forEach((seed, index) => {
      const startedAtSec = Math.trunc(seed.createdAtMs / 1000);
      insertTurn.run(seed.id, `turn-${index}`, startedAtSec, startedAtSec + 60, TURN_DURATION_MS);
    });
    historyDb.exec("COMMIT");
  } finally {
    historyDb.close();
  }

  return {
    root,
    env: { CODEX_HOME: root },
    stateDbPath,
    historyDbPath,
    oldThreadCount,
    recentAgesDays,
  };
}

function sqliteQueryDelta(before: UsageStoreCounters, after: UsageStoreCounters): number {
  return (
    after.sqliteWorkerQueries -
    before.sqliteWorkerQueries +
    (after.sqliteMainThreadQueries - before.sqliteMainThreadQueries)
  );
}

function expectedRecentTokens(recentAgesDays: number[], withinDays: number): number {
  return recentAgesDays.filter((ageDays) => ageDays < withinDays).length * RECENT_TOKENS_EACH;
}

/**
 * 事件循环 lag 探针：用 1ms 定时器测量相邻两次回调的实际间隔超出预期多少，
 * 取查询期间的最大值。这样「同步 SQLite / 长时间不让出的解析循环」会直接被量出来。
 */
function startEventLoopLagProbe(): { stop: () => number } {
  const intervalMs = 1;
  let maxLagMs = 0;
  let expectedAt = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - expectedAt);
    expectedAt = now + intervalMs;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return maxLagMs;
    },
  };
}

test("queryCodexAppUsageStats aggregates rollout per-turn model usage and SQLite fallback", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const codexHome = await createFixtureCodexHome(now);
  try {
    const env = { CODEX_HOME: codexHome };
    const snapshot7d = await queryCodexAppUsageStats(
      { range: "7d", timeZone: "UTC" },
      { env, now },
    );

    assert.equal(snapshot7d.range, "7d");
    assert.equal(snapshot7d.summary.totalTokens, 3500);
    assert.equal(snapshot7d.summary.inputTokens, 3000);
    assert.equal(snapshot7d.summary.outputTokens, 500);
    assert.equal(snapshot7d.summary.cacheReadTokens, 1400);
    assert.equal(snapshot7d.summary.longestSessionMs, 300_000);
    assert.equal(snapshot7d.models.length, 2);
    assert.deepEqual(
      snapshot7d.models.map((m) => ({
        modelId: m.modelId,
        totalTokens: m.totalTokens,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
      })),
      [
        {
          modelId: "gemini-4-argon",
          totalTokens: 2300,
          inputTokens: 2000,
          outputTokens: 300,
          cacheReadTokens: 1000,
        },
        {
          modelId: "gpt-5.4",
          totalTokens: 1200,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 400,
        },
      ],
    );

    const snapshot30d = await queryCodexAppUsageStats(
      { range: "30d", timeZone: "UTC" },
      { env, now },
    );
    assert.equal(snapshot30d.summary.totalTokens, 8500);
    assert.equal(snapshot30d.models.length, 3);
    assert.equal(snapshot30d.models[0]?.modelId, "claude-opus-5");
    assert.equal(snapshot30d.models[0]?.totalTokens, 5000);

    // Concurrent all + 7d queries coalesce in-flight rollout reads and produce consistent totals
    const [concurrentAll, concurrent7d] = await Promise.all([
      queryCodexAppUsageStats({ range: "all", timeZone: "UTC" }, { env, now }),
      queryCodexAppUsageStats({ range: "7d", timeZone: "UTC" }, { env, now }),
    ]);
    assert.equal(concurrentAll.summary.totalTokens, 8500);
    assert.equal(concurrent7d.summary.totalTokens, 3500);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("7d 在 DB 层过滤时间窗：历史线程的 rollout 一个都不读", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const recentAgesDays = [1, 2, 3, 5, 8, 10, 15, 20, 25, 29];
  const fixture = await createBulkFixtureCodexHome({ now, oldThreadCount: 1200, recentAgesDays });
  try {
    const before = readUsageStoreCounters();
    const snapshot = await queryCodexAppUsageStats(
      { range: "7d", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const after = readUsageStoreCounters();

    // 历史线程 rollout 里的毒样本时间戳落在 7d 窗口内，只要被读到总数立刻爆掉
    const recentWithin7d = recentAgesDays.filter((ageDays) => ageDays <= 7).length;
    assert.equal(snapshot.summary.totalTokens, recentWithin7d * RECENT_TOKENS_EACH);
    assert.equal(snapshot.summary.totalSessions, recentWithin7d);
    assert.equal(snapshot.summary.totalTurns, recentWithin7d);
    assert.equal(snapshot.summary.longestSessionMs, TURN_DURATION_MS);

    // 只有窗口内线程的 rollout 被读盘：1200 个历史线程的 rollout 一个都没打开
    assert.equal(after.rolloutParses - before.rolloutParses, recentWithin7d);
    assert.equal(after.rolloutCacheHits - before.rolloutCacheHits, 0);
    // 冷查询不可能命中全表缓存：state + history 各一次带 WHERE 下推的查询
    assert.equal(after.stateDbFullCacheHits - before.stateDbFullCacheHits, 0);
    assert.equal(after.historyDbFullCacheHits - before.historyDbFullCacheHits, 0);
    assert.equal(sqliteQueryDelta(before, after), 2);
    // 这两次查询都在 worker 线程完成，没有在主线程上跑同步 DatabaseSync
    assert.equal(after.sqliteWorkerQueries - before.sqliteWorkerQueries, 2);
    assert.equal(after.sqliteMainThreadQueries - before.sqliteMainThreadQueries, 0);

    // 反向验证：同一 fixture 的 all 必须把历史线程的 rollout 全读一遍，
    // 说明 7d 少读是时间窗生效，而不是漏读
    const beforeAll = readUsageStoreCounters();
    const allSnapshot = await queryCodexAppUsageStats(
      { range: "all", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const afterAll = readUsageStoreCounters();
    assert.equal(
      afterAll.rolloutParses - beforeAll.rolloutParses,
      fixture.oldThreadCount + (recentAgesDays.length - recentWithin7d),
    );
    assert.equal(afterAll.rolloutCacheHits - beforeAll.rolloutCacheHits, recentWithin7d);
    assert.equal(
      allSnapshot.summary.totalTokens,
      fixture.oldThreadCount * POISON_TOKENS_EACH + recentAgesDays.length * RECENT_TOKENS_EACH,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("超过 1000 个线程时连续 all 查询命中缓存，顺序扫描不会互相驱逐解析缓存", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const recentAgesDays = [1, 2, 3, 5, 8];
  const fixture = await createBulkFixtureCodexHome({ now, oldThreadCount: 1200, recentAgesDays });
  const threadCount = fixture.oldThreadCount + recentAgesDays.length;
  try {
    // 第一次 all：1205 个 rollout 全部解析一遍。旧上限 512 会在这一轮里就把先解析的条目挤出去
    const beforeFirst = readUsageStoreCounters();
    const first = await queryCodexAppUsageStats(
      { range: "all", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const afterFirst = readUsageStoreCounters();
    assert.equal(afterFirst.rolloutParses - beforeFirst.rolloutParses, threadCount);
    assert.equal(
      first.summary.totalTokens,
      fixture.oldThreadCount * POISON_TOKENS_EACH + recentAgesDays.length * RECENT_TOKENS_EACH,
    );

    // 第二次 all（DB 未变）：结果缓存命中 → 0 次 SQLite IO、0 次 rollout 读盘
    const beforeSecond = readUsageStoreCounters();
    const second = await queryCodexAppUsageStats(
      { range: "all", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const afterSecond = readUsageStoreCounters();
    assert.deepEqual(second.summary, first.summary);
    assert.equal(sqliteQueryDelta(beforeSecond, afterSecond), 0);
    assert.equal(afterSecond.rolloutParses - beforeSecond.rolloutParses, 0);
    assert.equal(afterSecond.rolloutCacheHits - beforeSecond.rolloutCacheHits, 0);
    assert.equal(afterSecond.stateDbFullCacheHits - beforeSecond.stateDbFullCacheHits, 0);

    // 只把 state db 的 mtime 往前推 1 秒：结果缓存与 threads 全表缓存必须立即失效，
    // 但 rollout 文件没变，所以这一轮必须全部命中解析缓存；
    // 若 LRU 上限小于线程数，这里会退化成 1205 次重新解析（cache thrashing）
    const stateStat = await stat(fixture.stateDbPath);
    const bumped = new Date(stateStat.mtimeMs + 1000);
    await utimes(fixture.stateDbPath, bumped, bumped);
    const beforeThird = readUsageStoreCounters();
    const third = await queryCodexAppUsageStats(
      { range: "all", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const afterThird = readUsageStoreCounters();
    assert.deepEqual(third.summary, first.summary);
    assert.equal(afterThird.rolloutParses - beforeThird.rolloutParses, 0);
    assert.equal(afterThird.rolloutCacheHits - beforeThird.rolloutCacheHits, threadCount);
    // threads 全表缓存失效要重读；thread_turns 指纹没变 → 命中全表缓存，0 次 SQLite IO
    assert.equal(afterThird.stateDbFullCacheHits - beforeThird.stateDbFullCacheHits, 0);
    assert.equal(afterThird.historyDbFullCacheHits - beforeThird.historyDbFullCacheHits, 1);
    assert.equal(sqliteQueryDelta(beforeThird, afterThird), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("冷 usage 查询期间 event-loop lag 有上限，SQLite 读取在 worker 线程完成", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const recentAgesDays = [1, 2, 3, 5, 8];
  const fixture = await createBulkFixtureCodexHome({ now, oldThreadCount: 1200, recentAgesDays });
  try {
    const before = readUsageStoreCounters();
    const probe = startEventLoopLagProbe();
    const snapshot = await queryCodexAppUsageStats(
      { range: "all", timeZone: "UTC" },
      { env: fixture.env, now },
    );
    const maxLagMs = probe.stop();
    const after = readUsageStoreCounters();

    assert.equal(
      snapshot.summary.totalTokens,
      fixture.oldThreadCount * POISON_TOKENS_EACH + recentAgesDays.length * RECENT_TOKENS_EACH,
    );
    // 冷读取全部走 worker：主线程一次同步 DatabaseSync 都没跑
    assert.equal(after.sqliteWorkerQueries - before.sqliteWorkerQueries, 2);
    assert.equal(after.sqliteMainThreadQueries - before.sqliteMainThreadQueries, 0);
    assert.ok(
      maxLagMs < EVENT_LOOP_LAG_BUDGET_MS,
      `1205 个线程的冷 all 查询期间 event-loop lag ${maxLagMs.toFixed(1)}ms，超过预算 ${EVENT_LOOP_LAG_BUDGET_MS}ms`,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all/7d/30d 并发只做必要读盘，DB 与 WAL 变化后缓存立即失效", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const recentAgesDays = [1, 2, 3, 5, 8, 10, 15, 20, 25, 29];
  const fixture = await createBulkFixtureCodexHome({
    now,
    oldThreadCount: 30,
    recentAgesDays,
    wal: true,
  });
  const threadCount = fixture.oldThreadCount + recentAgesDays.length;
  const query = (range: "all" | "7d" | "30d") =>
    queryCodexAppUsageStats({ range, timeZone: "UTC" }, { env: fixture.env, now });
  try {
    // 面板挂载的真实形态：三个 range 并发，外加一个同 key 的重复 all
    const beforeFirst = readUsageStoreCounters();
    const [all, seven, thirty, allDuplicate] = await Promise.all([
      query("all"),
      query("7d"),
      query("30d"),
      query("all"),
    ]);
    const afterFirst = readUsageStoreCounters();

    assert.equal(seven.summary.totalTokens, expectedRecentTokens(recentAgesDays, 7));
    assert.equal(thirty.summary.totalTokens, expectedRecentTokens(recentAgesDays, 30));
    assert.equal(
      all.summary.totalTokens,
      fixture.oldThreadCount * POISON_TOKENS_EACH + recentAgesDays.length * RECENT_TOKENS_EACH,
    );
    // 同 key 并发必须共享同一次计算（拿到同一个快照实例），否则重复请求会再读一遍盘
    assert.equal(allDuplicate, all);
    // 40 个 rollout 每个只读一次：parseRolloutUsage 的 in-flight 合并 + 解析缓存共同消除重复读盘
    assert.equal(afterFirst.rolloutParses - beforeFirst.rolloutParses, threadCount);
    // 三个 range 各自最多读 state + history 一次（重复的 all 不额外读）
    const firstQueries = sqliteQueryDelta(beforeFirst, afterFirst);
    assert.ok(firstQueries > 0 && firstQueries <= 6, `并发首查 SQLite 次数异常：${firstQueries}`);

    // 重复请求：结果缓存命中 → 完全不再读盘、不再查库
    const beforeSecond = readUsageStoreCounters();
    const [allAgain, sevenAgain, thirtyAgain] = await Promise.all([
      query("all"),
      query("7d"),
      query("30d"),
    ]);
    const afterSecond = readUsageStoreCounters();
    assert.deepEqual(allAgain.summary, all.summary);
    assert.deepEqual(sevenAgain.summary, seven.summary);
    assert.deepEqual(thirtyAgain.summary, thirty.summary);
    assert.equal(sqliteQueryDelta(beforeSecond, afterSecond), 0);
    assert.equal(afterSecond.rolloutParses - beforeSecond.rolloutParses, 0);
    assert.equal(afterSecond.rolloutCacheHits - beforeSecond.rolloutCacheHits, 0);

    // WAL 写入：主库文件一个字节都不变，只有 -wal 变化，缓存也必须立刻失效
    const writer = new DatabaseSync(fixture.stateDbPath);
    try {
      const mainBeforeInsert = await stat(fixture.stateDbPath);
      const insertedAtMs = now - 3_600_000;
      writer
        .prepare(
          `INSERT INTO threads (id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, model, tokens_used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wal-thread",
          join(fixture.root, "sessions", "missing-rollout.jsonl"),
          Math.trunc(insertedAtMs / 1000),
          insertedAtMs,
          Math.trunc(insertedAtMs / 1000),
          insertedAtMs,
          "gpt-5.5",
          4242,
        );
      const mainAfterInsert = await stat(fixture.stateDbPath);
      const walAfterInsert = await stat(`${fixture.stateDbPath}-wal`);
      // 写入只落在 WAL：指纹必须覆盖 -wal，否则这次写入对 usage 查询完全不可见
      assert.equal(mainAfterInsert.mtimeMs, mainBeforeInsert.mtimeMs);
      assert.equal(mainAfterInsert.size, mainBeforeInsert.size);
      assert.ok(walAfterInsert.size > 0);

      const beforeWal = readUsageStoreCounters();
      const [allAfterWal, sevenAfterWal] = await Promise.all([query("all"), query("7d")]);
      const afterWal = readUsageStoreCounters();
      // 新线程没有 rollout 文件，走 threads.tokens_used 兜底，因此不产生新的 rollout 读盘
      assert.equal(allAfterWal.summary.totalTokens, all.summary.totalTokens + 4242);
      assert.equal(sevenAfterWal.summary.totalTokens, seven.summary.totalTokens + 4242);
      assert.equal(afterWal.stateDbFullCacheHits - beforeWal.stateDbFullCacheHits, 0);
      assert.ok(sqliteQueryDelta(beforeWal, afterWal) > 0);
      assert.equal(afterWal.rolloutParses - beforeWal.rolloutParses, 0);
    } finally {
      writer.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
