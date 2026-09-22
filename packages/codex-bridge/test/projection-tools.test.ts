import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationSnapshotSchema,
  type PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexThreadItem } from "../src/codex-types.js";
import { projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

test("unknown native items remain visible but malformed known items fail closed", () => {
  const thread = threadFixture();
  const nativeTypes = [
    "webSearch",
    "imageView",
    "contextCompaction",
    "collabAgentToolCall",
    "futureItem",
  ];
  thread.turns[0]!.items.push(
    ...nativeTypes.map((type) => ({ type, id: type, detail: { preserved: true } })),
  );
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  const fallback = snapshot.rows.window.slice(-nativeTypes.length);
  assert.deepEqual(
    fallback.map((row) => row.entityId),
    nativeTypes,
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
      { path: "two.ts", kind: { type: "add" }, diff: "+new file" },
      { path: "three.ts", kind: { type: "delete" }, diff: "-old file" },
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
  assert.deepEqual(tools[0]?.input, { command: "printf hello", cwd: "/workspace" });
  assert.match(tools[1]?.output?.text ?? "", /three\.ts\n-old file/);
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
      { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/workspace", status },
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
    projectThread(thread, { ...options, interactions: [{ ...interaction, kind: "userInput" }] }),
  );
  if (interaction.payload.kind === "permission") interaction.payload.summary = "Changed by caller";
  assert.notDeepEqual(snapshot.pendingInteractions, [interaction]);
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
