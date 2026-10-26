import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_V4_LIMITS as limits,
  conversationSnapshotSchema,
  type ToolCallRow,
  type ToolOutput,
} from "@codez/shared/codez-protocol-v4";
import type { CodexThreadItem } from "../src/codex-types.js";
import { projectToolOutput } from "../src/projection-bounds.js";
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

// 下面三个函数是 preview() 加 UTF-16 长度短路之前那一行判断（只比 wire bytes）的本地参考实现，
// 用来钉住“短路不改变任何投影结果”。测试自持副本，不为此扩大 src 的导出面。
function referenceWireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function referenceEdge(text: string, budget: number, tail = false): string {
  const slice = (length: number) => {
    let start = tail ? text.length - length : 0;
    let end = tail ? text.length : length;
    const high = (at: number) => text.charCodeAt(at) >= 0xd800 && text.charCodeAt(at) <= 0xdbff;
    const low = (at: number) => text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;
    if (tail && low(start) && high(start - 1)) start++;
    if (!tail && high(end - 1) && low(end)) end--;
    return text.slice(start, end);
  };
  let lower = 0;
  let upper = Math.min(text.length, budget);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (referenceWireBytes(slice(middle)) <= budget) lower = middle;
    else upper = middle - 1;
  }
  return slice(lower);
}

function referenceProjectToolOutput(text: string): ToolOutput {
  if (referenceWireBytes(text) <= previewBytes) return { text };
  const totalBytes = Buffer.byteLength(text, "utf8");
  const marker = `\n[Codex tool output truncated; original ${totalBytes} UTF-8 bytes; full output unavailable]\n`;
  return {
    text:
      referenceEdge(text, limits.toolOutputFinalHeadBytes - referenceWireBytes(marker)) +
      marker +
      referenceEdge(text, limits.toolOutputFinalTailBytes, true),
    truncated: { totalBytes, ref: "" },
  };
}

test("every single UTF-16 code unit costs at least one wire byte (short-circuit invariant)", () => {
  // 短路正确性的全部前提：wireTextBytes(t) >= t.length 对每个码元成立，
  // 于是 length > budget 蕴含 wire > budget，新增比较只会跳过原本就要截断的输入。
  for (let code = 0; code < 0x1_0000; code++) {
    const unit = String.fromCharCode(code);
    assert.ok(referenceWireBytes(unit) >= unit.length, `U+${code.toString(16).padStart(4, "0")}`);
  }
});

test("NUL-heavy output below the UTF-16 budget still truncates on wire bytes", () => {
  // previewBytes = 32KiB head + 32KiB tail = 65536；NUL 被 JSON 转义成 6 字符的 \u0000，
  // 即 1 个 UTF-16 码元占 6 个 wire byte，65536 / 6 = 10922.67，所以边界落在 10922/10923。
  assert.equal(previewBytes, 65_536);
  const fits = "\u0000".repeat(10_922);
  const overflows = "\u0000".repeat(10_923);
  assert.ok(overflows.length < previewBytes, "长度守卫在这里必然放行，必须由 wire bytes 截断");
  assert.deepEqual(projectToolOutput(fits), { text: fits });
  const truncated = projectToolOutput(overflows);
  assert.deepEqual(truncated.truncated, { totalBytes: 10_923, ref: "" });
  assert.ok(referenceWireBytes(truncated.text) <= previewBytes);
  assert.ok(truncated.text.startsWith("\u0000") && truncated.text.endsWith("\u0000"));
  assert.deepEqual(truncated, referenceProjectToolOutput(overflows));
});

test("plain ASCII keeps the exact previewBytes boundary with no off-by-one from the guard", () => {
  // ASCII 是 wire bytes == UTF-16 length 的退化情形：短路前后必须落在同一个截断点。
  const atBudget = "x".repeat(previewBytes);
  const overBudget = "x".repeat(previewBytes + 1);
  assert.deepEqual(projectToolOutput(atBudget), { text: atBudget });
  const truncated = projectToolOutput(overBudget);
  assert.deepEqual(truncated.truncated, { totalBytes: previewBytes + 1, ref: "" });
  assert.ok(referenceWireBytes(truncated.text) <= previewBytes);
  assert.deepEqual(truncated, referenceProjectToolOutput(overBudget));
});

test("escapes, lone/paired surrogates and CJK project identically with and without the guard", () => {
  const units: [string, string][] = [
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udfff"],
    ["surrogate pair", "😀"],
    ["CJK", "界"],
    ["quote", '"'],
    ["backslash", "\\"],
    ["NUL", "\u0000"],
    ["newline+tab", "\n\t"],
    ["ascii", "x"],
  ];
  const lengths = [previewBytes - 1, previewBytes, previewBytes + 1, previewBytes * 2 + 1];
  for (const [label, unit] of units) {
    for (const length of lengths) {
      // 截断到精确长度可能劈开代理对，这正是需要覆盖的畸形输入。
      const text = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
      assert.equal(text.length, length, label);
      assert.deepEqual(
        projectToolOutput(text),
        referenceProjectToolOutput(text),
        `${label} @ ${length} UTF-16 units`,
      );
    }
  }
});
