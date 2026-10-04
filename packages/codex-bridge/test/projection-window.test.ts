import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_V4_LIMITS as limits,
  type ConversationRow,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import { projectConversationTailWindow } from "../src/projection-window.js";
import { projectThread } from "../src/projection.js";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { InteractionBroker } from "../src/interactions.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";
import { threadFixture } from "./projection-fixtures.test.js";

const cwd = "/workspace";
/** 每轮固定 4 行叙事（turnHeader + userInput + reasoning + assistantText）+ tools 行工具。 */
const narrativeRowsPerTurn = 4;

function port(): CodexRpcPort {
  return {
    async request() {
      throw new Error("unexpected native RPC");
    },
    async respond() {},
    async respondError() {},
  };
}

function turnFixture(seed: string, tools: number) {
  return {
    id: `turn-${seed}`,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 100,
    completedAt: 200,
    durationMs: 100_000,
    items: [
      {
        type: "userMessage",
        id: `${seed}-user`,
        clientId: `${seed}-command`,
        content: [{ type: "text", text: `question ${seed}`, text_elements: [] }],
      },
      { type: "reasoning", id: `${seed}-reasoning`, summary: [`thinking ${seed}`], content: [] },
      { type: "agentMessage", id: `${seed}-answer`, text: `answer ${seed}`, phase: "final_answer" },
      ...Array.from({ length: tools }, (_, index) => ({
        type: "commandExecution",
        id: `${seed}-exec-${index}`,
        command: `echo ${seed}-${index}`,
        cwd,
        status: "completed",
        aggregatedOutput: `output ${seed}-${index}`,
        exitCode: 0,
      })),
    ],
  };
}

function projectedRows(...turns: ReturnType<typeof turnFixture>[]): ConversationRow[] {
  const thread = threadFixture();
  thread.turns = turns as never;
  const snapshot = projectThread(thread, { workspacePath: cwd, logEpoch: "probe", seq: 1 });
  return [...snapshot.rows.window];
}

function kindsOf(rows: readonly ConversationRow[]): Set<string> {
  return new Set(rows.map((row) => row.kind));
}

test("a projection within the tail limit is published unchanged", () => {
  const rows = projectedRows(turnFixture("a", 5));
  assert.ok(rows.length <= limits.snapshotTailWindowRows);
  assert.deepEqual(
    projectConversationTailWindow(rows).map((row) => row.rowId),
    rows.map((row) => row.rowId),
  );
});

// 回归：原生把整轮思考/正文折叠钉在轮首，工具密集的长轮次一旦超过尾窗行数，
// 只按行数截尾会让窗口里 100% 是 toolCall——用户整轮只看得到工具调用。
test("a tool-heavy turn keeps its header, input, reasoning and answer inside the window", () => {
  const tools = limits.snapshotTailWindowRows * 2;
  const rows = projectedRows(turnFixture("a", tools));
  assert.equal(rows.length, tools + narrativeRowsPerTurn);
  // 旧行为的对照组：纯尾部截断只剩工具行。
  assert.deepEqual([...kindsOf(rows.slice(-limits.snapshotTailWindowRows))], ["toolCall"]);

  const window = projectConversationTailWindow(rows);
  assert.equal(window.length, rows.length);
  assert.equal(window[0]?.kind, "turnHeader");
  assert.equal(window[0]?.rowId, 0);
  for (const kind of ["turnHeader", "userInput", "reasoning", "assistantText"])
    assert.equal(kindsOf(window).has(kind), true, `${kind} 被尾窗挤出`);
  // rowId 必须连续：loadOlder 只能从窗口首行向前补，中间挖洞无法再补齐。
  assert.deepEqual(
    window.map((row) => row.rowId),
    rows.map((row) => row.rowId),
  );
});

test("turn anchoring never crosses into an older turn", () => {
  const tools = limits.snapshotTailWindowRows + 40;
  const rows = projectedRows(turnFixture("a", tools), turnFixture("b", tools));
  const window = projectConversationTailWindow(rows);
  assert.deepEqual([...new Set(window.map((row) => row.turnId))], ["turn-b"]);
  assert.equal(window[0]?.kind, "turnHeader");
  assert.equal(window.length, tools + narrativeRowsPerTurn);
  // 更早的轮次交给客户端 rows/range：窗口首行不是全序首行。
  assert.ok(window[0]!.rowId > rows[0]!.rowId);
});

test("the row cap truncates the middle but always keeps the leading turn header", () => {
  const rows = projectedRows(turnFixture("a", limits.snapshotTailWindowRows * 20));
  const maxRows = limits.snapshotTailWindowRows * 2;
  const window = projectConversationTailWindow(rows, { maxRows });
  // 缺 header 会让客户端每帧判定「首 turn 不完整」而反复 loadOlder，与每帧全量快照形成风暴。
  assert.equal(window[0]?.kind, "turnHeader");
  assert.equal(window[0]?.rowId, 0);
  assert.equal(window.length, maxRows + 1);
  assert.equal(window[1]?.rowId, rows.length - maxRows);
});

test("the byte budget binds before the row cap and still keeps the leading turn header", () => {
  const rows = projectedRows(turnFixture("a", limits.snapshotTailWindowRows * 4));
  const oneRow = Buffer.byteLength(JSON.stringify(rows[rows.length - 1]), "utf8");
  const window = projectConversationTailWindow(rows, {
    maxBytes: limits.snapshotTailWindowRows * oneRow + Math.floor(oneRow / 2),
  });
  assert.equal(window[0]?.kind, "turnHeader");
  assert.equal(window[0]?.rowId, 0);
  assert.ok(window.length < rows.length);
});

test("published snapshot keeps whole-projection firstRowId and totalCount", async () => {
  const tools = limits.snapshotTailWindowRows * 2;
  const thread = threadFixture();
  thread.turns = [turnFixture("a", tools), turnFixture("b", tools)] as never;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const full = await snapshots.conversation(thread.id);
  const published = (await snapshots.topic(`conversation/${thread.id}`))
    .snapshot as ConversationSnapshot;

  // firstRowId 跟随截尾改写会让 hasOlderRows 恒 false，rows/range 分页与「加载更早」入口静默失效。
  assert.equal(published.rows.firstRowId, full.rows.firstRowId);
  assert.equal(published.rows.firstRowId, 0);
  assert.equal(published.rows.totalCount, full.rows.totalCount);
  assert.ok(published.rows.window.length < published.rows.totalCount);
  assert.ok(published.rows.window[0]!.rowId > published.rows.firstRowId!);
  assert.equal(published.rows.window[0]?.kind, "turnHeader");
});
