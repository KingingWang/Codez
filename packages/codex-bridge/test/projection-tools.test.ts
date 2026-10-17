import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationSnapshotSchema,
  type PendingInteraction,
} from "@codez/shared/codez-protocol-v4";
import type { CodexThreadItem } from "../src/codex-types.js";
import { projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

test("unknown native items remain visible but malformed known items fail closed", () => {
  const thread = threadFixture();
  const nativeTypes = ["futureItem"];
  thread.turns[0]!.items.push(
    ...nativeTypes.map((type) => ({
      type,
      id: type,
      detail: { preserved: true },
    })),
  );
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  const fallback = snapshot.rows.window.slice(-nativeTypes.length);
  assert.deepEqual(
    fallback.map((row) => row.entityId),
    nativeTypes.map((type) => `codex:turn:turn-1:item:${type}`),
  );
  for (const row of fallback) {
    assert.equal(row.kind, "toolCall");
    if (row.kind === "toolCall") assert.match(row.output?.text ?? "", /preserved/);
  }
  for (const item of [
    { type: "commandExecution", id: "bad", command: 42, status: "completed" },
    { type: "agentMessage", id: "bad", text: 42 },
    { type: "userMessage", id: "bad", content: "not an array" },
  ]) {
    assert.throws(() =>
      projectThread(
        { ...thread, turns: [{ ...thread.turns[0], items: [item] }] },
        { workspacePath: "/workspace" },
      ),
    );
  }
});

test("availability overrides advertise only caller-certified capabilities", () => {
  const snapshot = projectThread(threadFixture(), {
    workspacePath: "/workspace",
    availability: { fork: { allowed: true }, queueEdit: { allowed: true } },
  });
  assert.equal(snapshot.availability.fork.allowed, true);
  assert.equal(snapshot.availability.queueEdit.allowed, true);
  assert.equal(snapshot.availability.pauseGoal.allowed, false);
});

// specs/codex-desktop-image-view.md：view_image 成功附加图片后产生的 imageView item
// 投影成 read 语义的工具卡（toolName view_image → UI file-read family → 可点击文件 chip），
// 不再落进 unknown 的 raw JSON 兜底卡。item 只在成功路径产生，状态恒为 success。
test("imageView items project as read-family tool cards carrying the image path", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "imageView",
    id: "img-1",
    path: "/tmp/screenshot.png",
  });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const row = snapshot.rows.window.at(-1);
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.entityId, "codex:turn:turn-1:item:img-1");
  assert.equal(row.toolCallId, "img-1");
  assert.equal(row.toolName, "view_image");
  assert.equal(row.status, "success");
  assert.deepEqual(row.input, { path: "/tmp/screenshot.png" });
  assert.equal(row.output, undefined);
});

// specs/codex-desktop-thread-items.md：pinned ThreadItem 全集都有显式投影。
test("webSearch projects as a search-family tool card carrying the query", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "webSearch",
    id: "ws-1",
    query: "codex app-server ThreadItem",
    action: null,
    results: null,
  });
  const row = projectThread(thread, { workspacePath: "/workspace" }).rows.window.at(-1);
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.toolName, "web_search");
  assert.equal(row.status, "success");
  assert.deepEqual(row.input, { query: "codex app-server ThreadItem" });
});

test("imageGeneration never leaks base64 results and maps status", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "imageGeneration",
    id: "gen-1",
    status: "completed",
    revisedPrompt: "a cat",
    result: "BASE64_IMAGE_BYTES_NEVER_IN_ROW",
    failure: null,
    savedPath: "/tmp/cat.png",
  });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  const row = snapshot.rows.window.at(-1);
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.toolName, "image_generation");
  assert.equal(row.status, "success");
  assert.deepEqual(row.input, { revisedPrompt: "a cat", savedPath: "/tmp/cat.png" });
  assert.equal(JSON.stringify(snapshot).includes("BASE64_IMAGE_BYTES_NEVER_IN_ROW"), false);

  const failed = threadFixture();
  failed.turns[0]!.items.push({
    type: "imageGeneration",
    id: "gen-2",
    status: "failed",
    revisedPrompt: null,
    result: "",
    failure: { type: "usageLimitExceeded", limitId: "image", resetsAt: null },
  });
  const failedRow = projectThread(failed, { workspacePath: "/workspace" }).rows.window.at(-1);
  assert.equal(failedRow?.kind, "toolCall");
  if (failedRow?.kind !== "toolCall") return;
  assert.equal(failedRow.status, "error");
  assert.match(failedRow.error?.message ?? "", /usageLimitExceeded/);
});

test("collabAgentToolCall projects real tool names, mapped status and per-agent states", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push(
    {
      type: "collabAgentToolCall",
      id: "spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "thread-1",
      receiverThreadIds: ["thread-2"],
      prompt: "inspect the codebase",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
    {
      type: "collabAgentToolCall",
      id: "wait-1",
      tool: "wait",
      status: "completed",
      senderThreadId: "thread-1",
      receiverThreadIds: ["thread-2"],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { "thread-2": { status: "completed", message: "done" } },
    },
    {
      type: "collabAgentToolCall",
      id: "msg-1",
      tool: "sendMessage",
      status: "completed",
      senderThreadId: "thread-1",
      receiverThreadIds: [],
      prompt: "ping",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
  );
  const rows = projectThread(thread, { workspacePath: "/workspace" }).rows.window;
  const tools = rows.filter((row) => row.kind === "toolCall");
  const [spawn, wait, msg] = tools.slice(-3);
  assert.equal(spawn?.toolName, "spawn_agent");
  assert.equal(spawn?.status, "running");
  assert.deepEqual(spawn?.input, {
    prompt: "inspect the codebase",
    senderThreadId: "thread-1",
    receiverThreadIds: ["thread-2"],
  });
  assert.equal(wait?.toolName, "wait_agent");
  assert.equal(wait?.status, "success");
  assert.match(wait?.output?.text ?? "", /thread-2: completed — done/);
  // v1 analytics-only 工具必须避开原生 SendMessage 渲染器。
  assert.equal(msg?.toolName, "codex_collab_send_message");
});

test("dynamicToolCall and functionCallOutput project text without media bytes", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push(
    {
      type: "dynamicToolCall",
      id: "dyn-1",
      namespace: "codez",
      tool: "summarize",
      arguments: { topic: "x" },
      status: "completed",
      contentItems: [
        { type: "inputText", text: "summary text" },
        { type: "inputImage", imageUrl: "data:image/png;base64,AAA" },
      ],
      success: true,
      durationMs: 12,
    },
    {
      type: "functionCallOutput",
      id: "fco-1",
      name: "hooked_tool",
      namespace: null,
      output: [{ type: "inputText", text: "hook output" }],
    },
  );
  const rows = projectThread(thread, { workspacePath: "/workspace" }).rows.window;
  const [dyn, fco] = rows.slice(-2);
  assert.equal(dyn?.kind, "toolCall");
  if (dyn?.kind !== "toolCall") return;
  assert.equal(dyn.toolName, "codez.summarize");
  assert.equal(dyn.status, "success");
  assert.deepEqual(dyn.input, { topic: "x" });
  assert.equal(dyn.output?.text, "summary text\n[image]");
  assert.equal(fco?.kind, "toolCall");
  if (fco?.kind !== "toolCall") return;
  assert.equal(fco.toolName, "hooked_tool");
  assert.equal(fco.output?.text, "hook output");
});

test("lifecycle items project as codexEvent timeline markers", () => {
  const thread = threadFixture();
  thread.turns[0]!.status = "inProgress";
  thread.turns[0]!.items.push(
    { type: "contextCompaction", id: "cc-1" },
    { type: "contextCompaction", id: "cc-running", status: "inProgress" },
    { type: "enteredReviewMode", id: "rev-1", review: "review current changes" },
    { type: "exitedReviewMode", id: "rev-2", review: "review current changes" },
    {
      type: "hookPrompt",
      id: "hook-1",
      fragments: [{ text: "injected context", hookRunId: "run-1" }],
    },
    {
      type: "subAgentActivity",
      id: "act-1",
      kind: "started",
      agentThreadId: "thread-2",
      agentPath: "worker[1]",
      model: null,
      reasoningEffort: null,
    },
    { type: "sleep", id: "sleep-1", durationMs: 5000 },
  );
  // subAgentActivity 现在除了分隔线还会产出一条 subagent 行（下钻入口，映射为 null），
  // 所以窗口多一行（specs/codex-desktop-subagent-drilldown.md）。
  const rows = projectThread(thread, { workspacePath: "/workspace" }).rows.window.slice(-8);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === "timelineMarker" && row.marker.type === "codexEvent"
        ? [row.marker.event, row.marker.status ?? null, row.marker.detail ?? null, row.lane]
        : null,
    ),
    [
      ["contextCompaction", null, null, "assistantWork"],
      ["contextCompaction", "running", null, "assistantWork"],
      ["reviewEnter", null, "review current changes", "assistantWork"],
      ["reviewExit", null, "review current changes", "assistantWork"],
      ["hookPrompt", null, "injected context", "assistantWork"],
      ["subagentStarted", null, "worker[1]", "assistantWork"],
      null,
      ["sleep", null, "5s", "assistantWork"],
    ],
  );
});

test("hookPrompt detail is capped so large injected context fits the row budget", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "hookPrompt",
    id: "hook-big",
    fragments: [{ text: "x".repeat(2000), hookRunId: "run-1" }],
  });
  const row = projectThread(thread, { workspacePath: "/workspace" }).rows.window.at(-1);
  assert.equal(row?.kind, "timelineMarker");
  if (row?.kind !== "timelineMarker" || row.marker.type !== "codexEvent") return;
  assert.equal(row.marker.detail?.length, 501);
});

const toolItems: CodexThreadItem[] = [
  {
    type: "commandExecution",
    id: "cmd",
    command: "printf hello",
    cwd: "/workspace",
    status: "completed",
    aggregatedOutput: "hello",
    exitCode: 0,
    durationMs: 500,
  },
  {
    type: "fileChange",
    id: "patch",
    status: "completed",
    changes: [
      {
        path: "one.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
      { path: "two.ts", kind: { type: "add" }, diff: "new file" },
      { path: "three.ts", kind: { type: "delete" }, diff: "old file" },
    ],
  },
  {
    type: "mcpToolCall",
    id: "mcp",
    server: "fixture",
    tool: "read",
    arguments: { key: "value" },
    status: "completed",
    result: {
      content: [{ type: "text", text: "result" }],
      structuredContent: { count: 1 },
      _meta: null,
    },
    error: null,
  },
];

test("command, file-change and MCP rows preserve structured input/output and valid statuses", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push(...structuredClone(toolItems));
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const tools = snapshot.rows.window.filter((row) => row.kind === "toolCall");
  assert.deepEqual(
    tools.map((row) => [row.toolCallId, row.toolName, row.status]),
    [
      ["cmd", "Bash", "success"],
      ["patch", "ApplyPatch", "success"],
      ["mcp", "mcp__fixture__read", "success"],
    ],
  );
  assert.equal(tools[0]?.output?.text, "hello");
  assert.deepEqual(tools[0]?.input, {
    command: "printf hello",
    cwd: "/workspace",
  });
  assert.match(tools[1]?.output?.text ?? "", /three\.ts\nold file/);
  assert.deepEqual(tools[1]?.output?.display, {
    kind: "file_diffs",
    totalFiles: 3,
    additions: 2,
    deletions: 2,
    files: [
      {
        kind: "file_diff",
        filePath: "one.ts",
        operation: "update",
        additions: 1,
        deletions: 1,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
      {
        kind: "file_diff",
        filePath: "two.ts",
        operation: "add",
        additions: 1,
        deletions: 0,
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ["+new file"],
          },
        ],
      },
      {
        kind: "file_diff",
        filePath: "three.ts",
        operation: "delete",
        additions: 0,
        deletions: 1,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            lines: ["-old file"],
          },
        ],
      },
    ],
  });
  assert.deepEqual(tools[2]?.display, {
    kind: "mcp_tool",
    serverName: "fixture",
    toolName: "read",
  });
  assert.equal(JSON.parse(tools[2]!.output!.text).structuredContent.count, 1);
  assert.equal(
    tools.every((row) => row.startedAt === undefined && row.endedAt === undefined),
    true,
  );
});

test("native file-change display survives large inputs with exact counts and bounded preview", () => {
  const thread = threadFixture();
  const body = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n");
  thread.turns[0]!.items.push({
    type: "fileChange",
    id: "large-patch",
    status: "completed",
    changes: [{ path: "src/large.ts", kind: { type: "add" }, diff: body }],
  });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const row = snapshot.rows.window.find(
    (item) => item.kind === "toolCall" && item.toolCallId === "large-patch",
  );
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.output?.display?.kind, "file_diff");
  if (row.output?.display?.kind !== "file_diff") return;
  assert.equal(row.output.display.additions, 300);
  assert.equal(row.output.display.deletions, 0);
  assert.equal(row.output.display.truncated, true);
  assert.equal(row.output.display.structuredPatch[0]?.lines.length, 160);
});

test("native file-change display bounds file count and escaped bytes without losing totals", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "fileChange",
    id: "many-files",
    status: "completed",
    changes: Array.from({ length: 40 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: { type: "add" as const },
      diff: index === 0 ? `"\\\u0000`.repeat(30_000) : `line ${index}\n`,
    })),
  });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  const row = snapshot.rows.window.find(
    (item) => item.kind === "toolCall" && item.toolCallId === "many-files",
  );
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.input, undefined);
  assert.equal(row.output?.display?.kind, "file_diffs");
  if (row.output?.display?.kind !== "file_diffs") return;
  assert.equal(row.output.display.totalFiles, 40);
  assert.equal(row.output.display.additions, 40);
  assert.equal(row.output.display.files.length, 32);
  assert.equal(row.output.display.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(row.output.display), "utf8") <= 48 * 1024);
});

test("native rename display keeps the source path and opens the destination", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "fileChange",
    id: "rename",
    status: "completed",
    changes: [
      {
        path: "src/before.ts",
        kind: { type: "update", move_path: "src/after.ts" },
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
  });
  const row = projectThread(thread, {
    workspacePath: "/workspace",
  }).rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === "rename");
  assert.equal(row?.kind === "toolCall" && row.output?.display?.kind, "file_diff");
  if (row?.kind !== "toolCall" || row.output?.display?.kind !== "file_diff") return;
  assert.equal(row.output.display.filePath, "src/before.ts");
  assert.equal(row.output.display.movePath, "src/after.ts");
});

test("tool failures and declines remain distinct, including nonzero command exits", () => {
  for (const [status, expected] of [
    ["completed", "success"],
    ["inProgress", "running"],
    ["failed", "error"],
    ["declined", "cancelled"],
  ] as const) {
    const thread = threadFixture();
    thread.turns[0]!.status = "inProgress";
    thread.status = { type: "active", activeFlags: [] };
    thread.turns[0]!.items = [
      {
        type: "commandExecution",
        id: "cmd",
        command: "pwd",
        cwd: "/workspace",
        status,
      },
    ];
    const row = projectThread(thread, { workspacePath: "/workspace" }).rows.window[1];
    assert.equal(row?.kind === "toolCall" && row.status, expected);
    if (expected === "error") assert.ok(row?.kind === "toolCall" && row.error?.message);
  }
  const thread = threadFixture();
  thread.turns[0]!.items = [
    {
      type: "commandExecution",
      id: "cmd",
      command: "false",
      cwd: "/workspace",
      status: "completed",
      exitCode: 1,
    },
  ];
  const row = projectThread(thread, { workspacePath: "/workspace" }).rows.window[1];
  assert.equal(row?.kind === "toolCall" && row.status, "error");
});

test("pending approvals are validated and tied to the matching tool, not other terminal tools", () => {
  const thread = threadFixture();
  thread.turns[0]!.status = "inProgress";
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  thread.turns[0]!.items.push({
    type: "commandExecution",
    id: "pending-tool",
    command: "pwd",
    cwd: "/workspace",
    status: "inProgress",
  });
  const interaction: PendingInteraction = {
    interactionId: "approval-1",
    kind: "permission",
    anchorRowId: null,
    createdAt: 102000,
    payload: {
      kind: "permission",
      toolCallId: "pending-tool",
      toolName: "Bash",
      summary: "Run pwd",
      detail: { command: "pwd" },
      options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
    },
  };
  const options = { workspacePath: "/workspace", interactions: [interaction] };
  const snapshot = projectThread(thread, options);
  const row = snapshot.rows.window.at(-1);
  assert.equal(row?.kind === "toolCall" && row.status, "pendingApproval");
  assert.equal(row?.kind === "toolCall" && row.approvalInteractionId, "approval-1");
  assert.deepEqual(snapshot.pendingInteractions, [interaction]);
  assert.equal(snapshot.inputRouting.mode, "reject");
  assert.equal(snapshot.control.canStop, true);
  assert.throws(() => projectThread(thread, { ...options, pendingInteractions: [] }), /not both/);
  assert.throws(() =>
    projectThread(thread, {
      ...options,
      interactions: [{ ...interaction, kind: "userInput" }],
    }),
  );
  if (interaction.payload.kind === "permission") interaction.payload.summary = "Changed by caller";
  assert.notDeepEqual(snapshot.pendingInteractions, [interaction]);
});

test("reused native tool IDs do not inherit an approval from another turn", () => {
  const thread = threadFixture();
  thread.turns.push({
    ...thread.turns[0]!,
    id: "turn-2",
    startedAt: 121,
    completedAt: null,
    items: [
      {
        type: "commandExecution",
        id: "reason-1",
        command: "pwd",
        cwd: "/workspace",
        status: "inProgress",
      },
    ],
  });
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const interaction: PendingInteraction = {
    interactionId: "turn-2-approval",
    kind: "permission",
    turnId: "turn-2",
    anchorRowId: null,
    createdAt: 122000,
    payload: {
      kind: "permission",
      toolCallId: "reason-1",
      toolName: "Bash",
      summary: "Run pwd in turn 2",
      detail: { command: "pwd" },
      options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
    },
  };
  const snapshot = projectThread(thread, {
    workspacePath: "/workspace",
    interactions: [interaction],
  });
  const reusedReasoning = snapshot.rows.window.find(
    (row) => row.entityId === "codex:turn:turn-1:item:reason-1",
  );
  const currentTool = snapshot.rows.window.find(
    (row) => row.entityId === "codex:turn:turn-2:item:reason-1",
  );
  assert.equal(reusedReasoning?.kind, "reasoning");
  assert.equal(currentTool?.kind === "toolCall" && currentTool.status, "pendingApproval");
  assert.equal(
    currentTool?.kind === "toolCall" && currentTool.approvalInteractionId,
    "turn-2-approval",
  );
});

test("reasoning and user media fallbacks retain content without inventing attachment facts", () => {
  const thread = threadFixture();
  thread.turns[0]!.items = [
    {
      type: "userMessage",
      id: "user-media",
      clientId: null,
      content: [
        { type: "text", text: "Look" },
        { type: "localImage", path: "/tmp/picture.png" },
        { type: "image", url: "https://example.invalid/picture" },
        { type: "skill", name: "skill", path: "/skill" },
      ],
    },
    {
      type: "reasoning",
      id: "reason",
      summary: ["Summary"],
      content: ["Reason one", "Reason two"],
    },
  ];
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  const user = snapshot.rows.window[1];
  assert.match(
    user?.kind === "userInput" ? user.text : "",
    /^Look\n\[image\]\n\[image\]\n\[skill: skill \(\/skill\)\]$/,
  );
  assert.equal(user?.kind === "userInput" && user.attachments, undefined);
  assert.equal(user?.kind === "userInput" && user.sourceCommandId, undefined);
  const reasoning = snapshot.rows.window[2];
  assert.equal(
    reasoning?.kind === "reasoning" && reasoning.text,
    "Summary\n\nReason one\n\nReason two",
  );
});

test("planUpdate items project as todo toolCall rows with structured plan input", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "planUpdate",
    id: "plan-update",
    explanation: "分两步走",
    plan: [
      { step: "探查代码", status: "completed" },
      { step: "实现", status: "in_progress" },
      { step: "验证", status: "pending" },
    ],
  } as unknown as CodexThreadItem);
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const row = snapshot.rows.window.find(
    (value) => value.kind === "toolCall" && value.toolName === "update_plan",
  );
  assert.ok(row && row.kind === "toolCall");
  assert.equal(row.status, "success");
  assert.equal(row.output, undefined);
  assert.deepEqual(row.input, {
    explanation: "分两步走",
    plan: [
      { step: "探查代码", status: "completed" },
      { step: "实现", status: "in_progress" },
      { step: "验证", status: "pending" },
    ],
  });
  assert.deepEqual(JSON.parse(row.inputText), row.input);
  // 合成 item 的展示身份必须与 thread-state 的固定 id 对齐，保证更新原位生效。
  assert.equal(row.entityId, "codex:turn:turn-1:item:plan-update");
});
