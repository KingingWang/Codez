import { describe, expect, it } from "vitest";
import type {
  ConversationRow,
  ReasoningRow,
  SubagentRow,
  ToolCallRow,
} from "@codez/shared/codez-protocol-v4";
import {
  buildAssistantWorkRenderItems,
  formatAssistantSummaryStatistics,
  getActiveAssistantSummaryItem,
  getAssistantSummaryTailRowId,
  getAssistantSummaryToolCategory,
  groupConsecutiveAssistantSummaries,
} from "@/v4/conversationAssistantWorkItems.js";

const SHOW_ALL_REASONING = { messageStreamShowReasoning: true } as const;

// 对齐现状：上游 v3.18.0 起 buildAssistantWorkRenderItems 只有两个入参，且不再产出
// exploreGroup / executeGroup / changesGroup / cuaGroup 这类合成父节点——工具分组的职责
// 移交给了同文件的 groupConsecutiveAssistantSummaries（摘要分组）。fork 旧分组实现、
// conversationCuaGroups.ts 与设置页三个开关都在那次 sync 里被整体删除（b95ebaffe）。
function buildRenderItems(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
  reasoningVisibility: Parameters<typeof buildAssistantWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  return buildAssistantWorkRenderItems(rows, reasoningVisibility);
}

function toolCall(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function subagent(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "running",
    summaryText: "正在分析工作区",
    childSessionId: `child-session-${rowId}`,
    ...overrides,
  };
}

function reasoning(rowId: number): ReasoningRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "reasoning",
    state: "complete",
    text: `reasoning-${rowId}`,
  };
}

describe("buildAssistantWorkRenderItems", () => {
  it("renders each tool call as its own row without synthetic group parents", () => {
    expect(buildRenderItems([toolCall(1, "Read", { path: "package.json" })])).toMatchObject([
      { kind: "row", row: { rowId: 1 } },
    ]);
    expect(buildRenderItems([toolCall(2, "Bash", { command: "pnpm test" })])).toMatchObject([
      { kind: "row", row: { rowId: 2 } },
    ]);
    expect(
      buildRenderItems([toolCall(3, "Edit", { path: "package.json", newText: "{}" })]),
    ).toMatchObject([{ kind: "row", row: { rowId: 3 } }]);
  });

  it("keeps consecutive same-family tools as individual rows", () => {
    // 现行契约：buildAssistantWorkRenderItems 不再合成父分组，连续同类工具也逐行渲染；
    // 「聚合展示」由 groupConsecutiveAssistantSummaries 在下一层负责（见文件末尾 describe）。
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Grep", { pattern: "a" }),
      toolCall(3, "Edit", { path: "src/a.ts", newText: "a" }),
      toolCall(4, "Read", { path: "src/b.ts" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it.each(["inputStreaming", "running"] as const)(
    "defers unclassified shell-family tools with status %s",
    (status) => {
      for (const toolName of ["Bash", "execute", "shell"]) {
        const pending = toolCall(
          1,
          toolName,
          {},
          {
            input: undefined,
            inputText: "",
            status,
          },
        );

        expect(buildRenderItems([pending])).toEqual([]);
      }
    },
  );

  it("classifies a deferred shell tool after its command arrives", () => {
    const readonly = toolCall(
      1,
      "Bash",
      { command: "rg test packages/ui" },
      { status: "inputStreaming" },
    );
    const executable = toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" });

    expect(buildRenderItems([readonly])).toMatchObject([{ kind: "row", row: { rowId: 1 } }]);
    expect(buildRenderItems([executable])).toMatchObject([{ kind: "row", row: { rowId: 2 } }]);
  });

  it("keeps an unclassified failed shell tool visible", () => {
    const failed = toolCall(
      1,
      "Bash",
      {},
      {
        error: { message: "Permission denied" },
        input: undefined,
        inputText: "",
        status: "error",
      },
    );

    expect(buildRenderItems([failed])).toMatchObject([
      { kind: "row", row: { rowId: 1, status: "error" } },
    ]);
  });

  it("keeps assistant text as a boundary between tool rows", () => {
    const rows = [
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Edit", { path: "package.json", newText: "{}" }),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "done",
        state: "complete",
      } satisfies ConversationRow,
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it("pairs agent tool calls with subagent rows by parentToolCallId", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "分析当前工作区",
        subagent_type: "Explore",
      }),
      subagent(2, { parentToolCallId: "tool-1" }),
      toolCall(3, "Read", { path: "package.json" }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["agentToolCall", "row"]);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.row.rowId).toBe(1);
    expect(agentItem.subagentRow.rowId).toBe(2);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
    expect(items.some((item) => item.kind === "row" && item.row.rowId === 2)).toBe(false);
  });

  // codex flavor 的 spawn 工具名是 spawn_agent（codex-bridge COLLAB_TOOL_NAMES.spawnAgent）。
  // 不在白名单里就配不上对：agent 卡片拿不到 childSessionId 入口，subagent 行还会重复渲染。

  it("pairs codex spawn_agent tool calls with projected subagent rows", () => {
    const rows = [
      toolCall(1, "spawn_agent", {
        prompt: "调查子代理下钻",
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2"],
      }),
      subagent(2, {
        parentToolCallId: "tool-1",
        subagentType: "subagent",
        childSessionId: "thread-2",
        summaryText: "调查子代理下钻",
      }),
      toolCall(3, "wait_agent", {
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2"],
      }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["agentToolCall", "row"]);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.subagentRow.childSessionId).toBe("thread-2");
    // wait_agent 等后续交互工具不进白名单：同一子代理只允许一张可点卡片。
    expect(items.some((item) => item.kind === "row" && item.row.rowId === 2)).toBe(false);
  });

  it("keeps concurrent agent details bound when subagents spawn in reverse order", () => {
    const rows = [
      toolCall(1, "Agent", { description: "测试 general-purpose agent" }),
      toolCall(2, "Agent", { description: "测试 Explore agent" }),
      toolCall(3, "Agent", { description: "测试 test-hello2 agent" }),
      subagent(4, {
        childSessionId: "child-test-hello2",
        parentToolCallId: "tool-3",
        subagentType: "test-hello2",
      }),
      subagent(5, {
        childSessionId: "child-explore",
        parentToolCallId: "tool-2",
        subagentType: "Explore",
      }),
      subagent(6, {
        childSessionId: "child-general-purpose",
        parentToolCallId: "tool-1",
        subagentType: "general-purpose",
      }),
    ];

    const items = buildRenderItems(rows);
    const pairs = items.flatMap((item) =>
      item.kind === "agentToolCall" ? [[item.row.toolCallId, item.subagentRow.childSessionId]] : [],
    );

    expect(pairs).toEqual([
      ["tool-1", "child-general-purpose"],
      ["tool-2", "child-explore"],
      ["tool-3", "child-test-hello2"],
    ]);
  });

  it("only falls back for one unambiguous legacy pair", () => {
    const onePair = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent" }),
      subagent(2),
    ]);
    expect(onePair).toMatchObject([
      {
        kind: "agentToolCall",
        row: { rowId: 1 },
        subagentRow: { rowId: 2 },
      },
    ]);

    const ambiguous = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent A" }),
      toolCall(2, "Agent", { description: "旧 Agent B" }),
      subagent(3),
      subagent(4),
    ]);
    expect(ambiguous.some((item) => item.kind === "agentToolCall")).toBe(false);
    expect(ambiguous.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("keeps background subagents paired without requesting an inline output preview", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "后台分析当前工作区",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      subagent(2, { backgrounded: true, parentToolCallId: "tool-1" }),
    ];

    const items = buildRenderItems(rows);

    expect(items).toHaveLength(1);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.subagentRow.backgrounded).toBe(true);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
  });
});

// ── 现行分组契约（上游 v3.18.0 起）────────────────────────────────────────────
// fork 旧的 exploreGroup / executeGroup / changesGroup / cuaGroup 合成父节点随上游 sync
// （b95ebaffe）整体下线：设置页三个开关、conversationCuaGroups.ts 与分组 builder 一并删除，
// 工具聚合改由 groupConsecutiveAssistantSummaries 承担——它按「连续可摘要项」聚成摘要组，
// 正文/子代理卡片/未归类工具作为边界，不重新拼接真实工具关系。
describe("groupConsecutiveAssistantSummaries", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }, values?: { count?: number }) =>
      values?.count === undefined ? id : `${id}:${values.count}`,
  } as never;

  it("collapses consecutive reasoning and categorized tools into one summary group", () => {
    const items = buildRenderItems([
      reasoning(1),
      toolCall(2, "Read", { path: "src/a.ts" }),
      toolCall(3, "Grep", { pattern: "a" }),
      toolCall(4, "Bash", { command: "pnpm test" }),
      toolCall(5, "Write", { file_path: "src/b.ts", content: "b" }),
    ]);

    const groups = groupConsecutiveAssistantSummaries(items);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(items[0]!.key);
    expect(groups[0]!.items.map((item) => item.key)).toEqual(items.map((item) => item.key));
  });

  it("breaks the group at assistant text and starts a new group after the boundary", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Grep", { pattern: "a" }),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "done",
        state: "complete",
      } satisfies ConversationRow,
      toolCall(4, "Read", { path: "src/b.ts" }),
    ]);

    const groups = groupConsecutiveAssistantSummaries(items);

    expect(groups.map((group) => group.items.map((item) => item.key))).toEqual([
      ["row:1", "row:2"],
      ["row:3"],
      ["row:4"],
    ]);
  });

  it("breaks the group at agent tool cards and keeps them as single-item groups", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "spawn_agent", { task_name: "worker" }),
      subagent(3, { parentToolCallId: "tool-2" }),
      toolCall(4, "Grep", { pattern: "a" }),
    ]);

    const groups = groupConsecutiveAssistantSummaries(items);

    expect(groups.map((group) => group.items.map((item) => item.kind))).toEqual([
      ["row"],
      ["agentToolCall"],
      ["row"],
    ]);
  });

  it("hides later reasoning when only the first reasoning row is visible", () => {
    const rows = [
      toolCall(1, "Read", { path: "src/a.ts" }),
      reasoning(2),
      toolCall(3, "Grep", { pattern: "a" }),
    ];

    const hidden = buildRenderItems(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 2,
    });
    expect(hidden.map((item) => item.key)).toEqual(["row:1", "row:2", "row:3"]);
    // 隐藏的 reasoning 不再是边界：三项仍聚成一个摘要组。
    expect(groupConsecutiveAssistantSummaries(hidden)).toHaveLength(1);

    // 打开思考展示后，reasoning 行本身也进入同一摘要组（它是可摘要项）。
    const shown = buildRenderItems(rows, {
      messageStreamShowReasoning: true,
    });
    expect(shown.map((item) => item.key)).toEqual(["row:1", "row:2", "row:3"]);
    expect(groupConsecutiveAssistantSummaries(shown)).toHaveLength(1);
  });

  it("hides todo tool rows unless messageStreamShowTodos is on", () => {
    const rows = [toolCall(1, "Read", { path: "src/a.ts" }), toolCall(2, "TodoWrite", { todos: [] })];

    expect(
      buildRenderItems(rows, { messageStreamShowReasoning: true }).map((item) => item.key),
    ).toEqual(["row:1"]);
    expect(
      buildRenderItems(rows, {
        messageStreamShowReasoning: true,
        messageStreamShowTodos: true,
      }).map((item) => item.key),
    ).toEqual(["row:1", "row:2"]);
  });

  it("counts explore, run and deduplicated changed files for the summary label", () => {
    const items = buildRenderItems([
      reasoning(1),
      toolCall(2, "Read", { path: "src/a.ts" }),
      toolCall(3, "Grep", { pattern: "a" }),
      toolCall(4, "Bash", { command: "pnpm test" }),
      toolCall(5, "Write", { file_path: "src/b.ts", content: "b" }),
    ]);

    const statistics = formatAssistantSummaryStatistics(items, intl, "/workspace");

    // one/other 由计数决定：2 个只读工具走 other，1 次执行与 1 个改动文件走 one。
    expect(statistics).toBe(
      [
        "chat.summaryGroup.explore.other:2",
        "chat.summaryGroup.separator",
        "chat.summaryGroup.run.one:1",
        "chat.summaryGroup.separator",
        "chat.summaryGroup.change.one:1",
      ].join(""),
    );
  });

  it("falls back to the reasoning label when nothing is countable", () => {
    expect(formatAssistantSummaryStatistics(buildRenderItems([reasoning(1)]), intl)).toBe(
      "chat.summaryGroup.reasoning",
    );
  });

  it("categorizes tool rows and leaves approval-pending or workflow rows uncategorized", () => {
    expect(getAssistantSummaryToolCategory(toolCall(1, "Read", { path: "src/a.ts" }))).toBe(
      "explore",
    );
    expect(getAssistantSummaryToolCategory(toolCall(2, "Bash", { command: "pnpm test" }))).toBe(
      "run",
    );
    expect(
      getAssistantSummaryToolCategory(
        toolCall(3, "Write", { file_path: "src/b.ts", content: "b" }),
      ),
    ).toBe("change");
    expect(
      getAssistantSummaryToolCategory(
        toolCall(4, "Read", { path: "src/a.ts" }, { status: "pendingApproval" }),
      ),
    ).toBeNull();
    expect(getAssistantSummaryToolCategory(reasoning(5))).toBeNull();
  });

  it("tracks the visible tail row and the still-running summary item", () => {
    const rows = [
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" }),
    ];

    expect(getAssistantSummaryTailRowId(rows, SHOW_ALL_REASONING)).toBe(2);
    expect(
      getAssistantSummaryTailRowId(
        [
          ...rows,
          {
            rowId: 3,
            turnId: "turn-1",
            createdAt: 1_700_000_003,
            createdAtSeq: 3,
            kind: "userInput",
            text: "next",
            state: "complete",
          } satisfies ConversationRow,
        ],
        SHOW_ALL_REASONING,
      ),
    ).toBeUndefined();
    expect(getActiveAssistantSummaryItem(buildRenderItems(rows))?.key).toBe("row:2");
  });
});
