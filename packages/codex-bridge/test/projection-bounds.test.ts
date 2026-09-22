import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_V4_LIMITS as limits,
  conversationSnapshotSchema,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexThreadItem } from "../src/codex-types.js";
import { projectInputText, projectLegacySnapshot, projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

// Executable spec: native history remains authoritative and unchanged. Both delivery
// profiles share bounded, labeled previews, not a second full-output cache/ref store.
const previewBytes = limits.toolOutputFinalHeadBytes + limits.toolOutputFinalTailBytes;
const huge = `HEAD:${"界😀\n\u0000".repeat(150_000)}:TAIL`;
const options = { workspacePath: "/workspace", logEpoch: "same-epoch", seq: 7, revision: 8 };

test("native images use a stable marker without leaking base64, URLs or sidecar paths", () => {
  const input = [
    {
      type: "image" as const,
      detail: null,
      url: `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`,
    },
    { type: "image" as const, url: "https://example.invalid/private-image?secret=fixture" },
    { type: "localImage" as const, path: "/private/bridge/attachments/secret.png" },
  ];
  const original = structuredClone(input);
  assert.equal(projectInputText(input), "[image]\n[image]\n[image]");
  const thread = threadFixture();
  thread.turns[0]!.items = [{ type: "userMessage", id: "images", content: input }];
  const queue = [{ id: "queued-images", clientUserMessageId: "external", input }];
  const snapshot = projectThread(thread, { ...options, queue });
  const row = snapshot.rows.window[1]!;
  assert.equal(row.kind === "userInput" && row.text, "[image]\n[image]\n[image]");
  assert.equal(row.kind === "userInput" && row.attachments, undefined);
  const wire = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(wire) < 16 * 1024);
  for (const value of ["data:image", "example.invalid", "/private/bridge", "secret=fixture"])
    assert.equal(wire.includes(value), false);
  const legacy = projectLegacySnapshot(thread, "/workspace");
  const part = legacy.messages[0]!.parts[0]!;
  assert.equal(part.type === "text" && part.text, "[image]\n[image]\n[image]");
  assert.deepEqual(input, original);
});

function projectTool(item: CodexThreadItem): ToolCallRow {
  const thread = threadFixture();
  thread.turns[0]!.items.push(item);
  const original = structuredClone(thread);
  const snapshot = projectThread(thread, options);
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  assert.deepEqual(projectThread(thread, options), snapshot);
  assert.deepEqual(thread, original);
  assert.equal(snapshot.logEpoch, options.logEpoch);
  assert.equal(snapshot.seq, options.seq);
  assert.equal(snapshot.revision, options.revision);
  const row = snapshot.rows.window.at(-1)!;
  assert.equal(row.kind, "toolCall");
  return row as ToolCallRow;
}

function assertPreview(row: ToolCallRow, originalOutput: string) {
  assert.ok(Buffer.byteLength(originalOutput) > 1024 * 1024);
  assert.deepEqual(row.output?.truncated, {
    totalBytes: Buffer.byteLength(originalOutput),
    ref: "", // Explicit unavailable sentinel; there is no full-output query implementation.
  });
  assert.ok(Buffer.byteLength(row.output!.text) <= previewBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(row.output!.text)) - 2 <= previewBytes);
  assert.ok(originalOutput.startsWith(row.output!.text.slice(0, 30)));
  assert.ok(originalOutput.endsWith(row.output!.text.slice(-30)));
  assert.match(row.output!.text, /truncated.*full output unavailable/);
  assert.ok(!row.output!.text.includes("\uFFFD"), "UTF-8/codepoint boundaries remain intact");
  assert.ok(!row.inputText.includes("\uFFFD"));
}

test("large native command output has deterministic UTF-8 head/tail with honest metadata", () => {
  const row = projectTool({
    type: "commandExecution",
    id: "cmd",
    command: "printf fixture",
    cwd: "/workspace",
    status: "completed",
    aggregatedOutput: huge,
  });
  assertPreview(row, huge);
  assert.deepEqual(row.input, { command: "printf fixture", cwd: "/workspace" });
});

test("large MCP input/result, file diffs and unknown JSON cannot hide unbounded copies", () => {
  const result = { content: [{ type: "text", text: huge }], structuredContent: { data: huge } };
  const unknown = { type: "futureItem", id: "unknown", payload: huge };
  const examples: [CodexThreadItem, string][] = [
    [
      {
        type: "mcpToolCall",
        id: "mcp",
        server: "fixture",
        tool: "read",
        status: "completed",
        arguments: { data: huge },
        result,
      },
      JSON.stringify(result),
    ],
    [
      {
        type: "fileChange",
        id: "patch",
        status: "completed",
        changes: [{ path: "file.ts", kind: { type: "add" }, diff: huge }],
      },
      `file.ts\n${huge}`,
    ],
    [
      unknown,
      `Codex futureItem (generic presentation; status may be turn-derived)\n${JSON.stringify(unknown)}`,
    ],
  ];
  for (const [item, output] of examples) {
    const row = projectTool(item);
    assertPreview(row, output);
    assert.equal(row.input, undefined, "partial JSON/diff is never certified as complete input");
    assert.match(row.inputText, /truncated.*structured input omitted/);
    assert.ok(Buffer.byteLength(JSON.stringify(row.inputText)) - 2 <= previewBytes);
    assert.throws(() => JSON.parse(row.inputText));
    assert.ok(Buffer.byteLength(JSON.stringify(row)) < 3 * previewBytes);
  }
});

test("sixty large tool rows remain below assembly budget, even JSON-escaped control output", () => {
  const thread = threadFixture();
  thread.turns[0]!.items = Array.from({ length: limits.snapshotTailWindowRows }, (_, index) => ({
    type: "commandExecution",
    id: `cmd-${index}`,
    command: "printf fixture",
    cwd: "/workspace",
    status: "completed",
    aggregatedOutput: "\u0000".repeat(1024 * 1024 + 1),
  }));
  const snapshot = projectThread(thread, options);
  assert.equal(snapshot.rows.totalCount, limits.snapshotTailWindowRows + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < limits.logicalFrameAssemblyMaxBytes);
  for (const row of snapshot.rows.window.slice(1)) {
    assert.equal(row.kind, "toolCall");
    assert.ok((row as ToolCallRow).output?.truncated);
  }
});

test("small and exactly-budget tool output remains exact without false truncation", () => {
  for (const output of ["", "hello 界😀", "x".repeat(previewBytes)]) {
    const row = projectTool({
      type: "commandExecution",
      id: "cmd",
      command: "pwd",
      cwd: "/workspace",
      status: "completed",
      aggregatedOutput: output,
    });
    assert.deepEqual(row.output, { text: output });
  }
});

test("oversized user/assistant/plan/reasoning text fails explicitly, never silently truncates", () => {
  const items: CodexThreadItem[] = [
    { type: "userMessage", id: "large-user", content: [{ type: "text", text: huge }] },
    { type: "agentMessage", id: "large-assistant", text: huge },
    { type: "plan", id: "large-plan", text: huge },
    { type: "reasoning", id: "large-reasoning", summary: [], content: [huge] },
  ];
  for (const item of items) {
    const thread = threadFixture();
    thread.turns[0]!.items.push(item);
    assert.throws(() => projectThread(thread, options), /Codex projection row .* exceeds .* bytes/);
    assert.throws(() => projectLegacySnapshot(thread, "/workspace"), /exceeds .* bytes/);
    assert.deepEqual(thread.turns[0]!.items.at(-1), item);
  }
});

test("legacy tool display retains truncation provenance without inventing a retrieval ref", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "commandExecution",
    id: "cmd",
    command: "pwd",
    cwd: "/workspace",
    status: "completed",
    aggregatedOutput: huge,
  });
  const snapshot = projectLegacySnapshot(thread, "/workspace");
  const part = snapshot.messages.at(-1)!.parts[0]!;
  assert.equal(part.type, "tool");
  if (part.type !== "tool" || part.state.status !== "completed") assert.fail("completed tool");
  assert.match(part.state.output, /truncated/);
  assert.deepEqual(part.state.metadata?.outputTruncated, {
    totalBytes: Buffer.byteLength(huge),
    ref: "",
  });
});
