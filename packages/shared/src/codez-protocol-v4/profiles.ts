// Delivery profile 过滤纯函数。
// 通道层 flush 管线的第一步：filter → coalesce → 打帧。恢复回放走同一函数
// （「先过该订阅者的 profile 过滤器再 coalesce」），保证断线重连的确定性重投递。
//
// 收口不变量（进黄金测试）：被 profile 过滤的事件必须最终被某个不可过滤的事件收口——
// row.delta(inputText) 被滤掉后，工具输入定稿时的 row.upserted 必须携带完整 inputText，
// 否则 replayable 订阅者终态缺数据。任何 reducer 改动破坏该不变量会撞
// 「两 profile 终态逐字节一致」测试。
import { PROTOCOL_V4_LIMITS, type DeliveryProfile } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow, ReasoningRow, ToolCallRow } from "./rows.js";
import type { ToolOutput, ToolResultDisplay } from "./toolDisplay.js";

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function sliceSafeUtf8Prefix(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let end = mid;
    const prevCode = end > 0 ? text.charCodeAt(end - 1) : 0;
    const nextCode = end < text.length ? text.charCodeAt(end) : 0;
    if (prevCode >= 0xd800 && prevCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
      end -= 1;
    }
    if (utf8Bytes(text.slice(0, end)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let finalEnd = low;
  const prevCode = finalEnd > 0 ? text.charCodeAt(finalEnd - 1) : 0;
  const nextCode = finalEnd < text.length ? text.charCodeAt(finalEnd) : 0;
  if (prevCode >= 0xd800 && prevCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
    finalEnd -= 1;
  }
  return text.slice(0, finalEnd);
}

// 轮尾外提或首屏常驻结构化卡片工具：保持完整内联，避免首屏额外往返或丢卡片。
const EXEMPT_INLINE_TOOL_NAMES = new Set([
  "exitplanmode",
  "croncreate",
  "cronupdate",
  "crondelete",
  "offpeakcreate",
  "todowrite",
  "todoread",
  "update_plan",
  "askuserquestion",
  "createworkflow",
  "amendworkflow",
  "fillworkflowhole",
  "saveworkflow",
  "listsavedworkflows",
  "getworkflowrun",
  "listworkflowruns",
  "resumeworkflowrun",
  "evalworkflowsnippet",
  "listmodels",
  "escalate",
  "resolveworkflowquestion",
  "submit_result",
  "sendmessage",
  "respondtocoordinator",
  "taskoutput",
  "taskstop",
]);

// 大体积参数键：仅在终态工具行整体 input 超过 toolInputInlineMaxBytes 时剥离，
// 保留路径/命令等折叠摘要键，使 Explore/Execute/Edit 分类与文件名芯片零损失。
const HEAVY_TOOL_INPUT_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "newString",
  "oldString",
  "patch",
  "diff",
  "changes",
  "code",
  "file_text",
  "text",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExemptToolRow(row: ToolCallRow): boolean {
  const normalized = row.toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, "");
  if (EXEMPT_INLINE_TOOL_NAMES.has(normalized)) return true;
  if (row.display?.kind === "node_repl_images" && row.display.source === "browser_turn_end") {
    return true;
  }
  if (row.display?.kind === "mcp_tool" && row.display.ui !== undefined) {
    return true;
  }
  if (row.output?.display?.kind === "mcp_tool" && row.output.display.ui !== undefined) {
    return true;
  }
  return false;
}

function compactToolResultDisplay(display: ToolResultDisplay): {
  display: ToolResultDisplay;
  changed: boolean;
} {
  if (display.kind === "file_diff") {
    if (display.structuredPatch.length === 0) {
      return { display, changed: false };
    }
    return {
      display: {
        ...display,
        structuredPatch: [],
        truncated: true,
      },
      changed: true,
    };
  }
  if (display.kind === "file_diffs") {
    const hasNonEmptyPatches = display.files.some((file) => file.structuredPatch.length > 0);
    if (!hasNonEmptyPatches) {
      return { display, changed: false };
    }
    return {
      display: {
        ...display,
        files: display.files.map((file) =>
          file.structuredPatch.length === 0
            ? file
            : {
                ...file,
                structuredPatch: [],
                truncated: true,
              },
        ),
        truncated: true,
      },
      changed: true,
    };
  }
  if (
    display.kind === "bash_output" &&
    utf8Bytes(display.output) > PROTOCOL_V4_LIMITS.toolOutputInlinePreviewBytes
  ) {
    return {
      display: {
        ...display,
        output: `${sliceSafeUtf8Prefix(display.output, PROTOCOL_V4_LIMITS.toolOutputInlinePreviewBytes)}\n…`,
        truncated: true,
      },
      changed: true,
    };
  }
  return { display, changed: false };
}

function compactToolOutput(output: ToolOutput, rowId: number): ToolOutput {
  let nextDisplay = output.display;
  let displayCompacted = false;
  if (output.display) {
    const compacted = compactToolResultDisplay(output.display);
    nextDisplay = compacted.display;
    displayCompacted = compacted.changed;
  }
  const textBytes = utf8Bytes(output.text);
  const limit = PROTOCOL_V4_LIMITS.toolOutputInlinePreviewBytes;
  if (textBytes <= limit && !displayCompacted) {
    return output;
  }
  const totalBytes =
    output.truncated?.totalBytes ??
    (displayCompacted ? Math.max(textBytes, utf8Bytes(JSON.stringify(output.display))) : textBytes);
  const previewText =
    textBytes > limit ? `${sliceSafeUtf8Prefix(output.text, limit)}\n…` : output.text;
  return {
    text: previewText,
    ...(nextDisplay ? { display: nextDisplay } : {}),
    truncated: {
      totalBytes,
      ref: output.truncated?.ref || `v4-row-payload/${rowId}`,
    },
  };
}

function compactToolInputRecord(record: Record<string, unknown>): {
  compactRecord: Record<string, unknown>;
  stripped: boolean;
} {
  const compactRecord: Record<string, unknown> = {};
  let stripped = false;
  for (const [key, value] of Object.entries(record)) {
    if (HEAVY_TOOL_INPUT_KEYS.has(key)) {
      if (typeof value === "string" && utf8Bytes(value) > 256) {
        stripped = true;
        continue;
      }
      if (Array.isArray(value) || isPlainObject(value)) {
        const serialized = JSON.stringify(value) ?? "";
        if (utf8Bytes(serialized) > 256) {
          stripped = true;
          continue;
        }
      }
    }
    if (typeof value === "string" && utf8Bytes(value) > 512) {
      compactRecord[key] = `${sliceSafeUtf8Prefix(value, 256)}…`;
      stripped = true;
    } else {
      compactRecord[key] = value;
    }
  }
  return { compactRecord, stripped };
}

export function compactReasoningRowForWire(row: ReasoningRow): ReasoningRow {
  if (row.state === "streaming") return row;
  const limit = PROTOCOL_V4_LIMITS.reasoningInlinePreviewBytes;
  const totalBytes = row.truncated?.totalBytes ?? utf8Bytes(row.text);
  if (utf8Bytes(row.text) <= limit) return row;
  return {
    ...row,
    text: `${sliceSafeUtf8Prefix(row.text, limit)}\n…`,
    truncated: {
      totalBytes,
      ref: `v4-row-payload/${row.rowId}`,
    },
  };
}

export function compactToolCallRowForWire(row: ToolCallRow): ToolCallRow {
  if (
    row.status === "inputStreaming" ||
    row.status === "pendingApproval" ||
    row.status === "running"
  ) {
    return row;
  }
  if (isExemptToolRow(row)) return row;

  let nextOutput = row.output;
  if (row.output) {
    nextOutput = compactToolOutput(row.output, row.rowId);
  }

  let nextInput = row.input;
  let nextInputText = row.inputText;
  let nextInputTruncated = row.inputTruncated;
  const inputBytes = Math.max(
    utf8Bytes(row.inputText),
    row.input !== undefined ? utf8Bytes(JSON.stringify(row.input) ?? "") : 0,
  );
  if (inputBytes > PROTOCOL_V4_LIMITS.toolInputInlineMaxBytes) {
    if (isPlainObject(row.input)) {
      const { compactRecord, stripped } = compactToolInputRecord(row.input);
      if (stripped) {
        nextInput = compactRecord;
        nextInputText = JSON.stringify(compactRecord);
        nextInputTruncated = {
          totalBytes: inputBytes,
          ref: `v4-row-payload/${row.rowId}`,
        };
      } else if (row.input !== undefined && row.inputText.length > 0) {
        nextInputText = "";
      }
    } else if (utf8Bytes(row.inputText) > PROTOCOL_V4_LIMITS.toolInputInlineMaxBytes) {
      nextInputText = `${sliceSafeUtf8Prefix(row.inputText, 256)}…`;
      nextInputTruncated = {
        totalBytes: inputBytes,
        ref: `v4-row-payload/${row.rowId}`,
      };
    }
  }

  if (
    nextOutput === row.output &&
    nextInput === row.input &&
    nextInputText === row.inputText &&
    nextInputTruncated === row.inputTruncated
  ) {
    return row;
  }

  return {
    ...row,
    inputText: nextInputText,
    ...(nextInput !== undefined ? { input: nextInput } : {}),
    ...(nextInputTruncated ? { inputTruncated: nextInputTruncated } : {}),
    ...(nextOutput ? { output: nextOutput } : {}),
  };
}

export function compactConversationRowForWire(row: ConversationRow): ConversationRow {
  if (row.kind === "reasoning") return compactReasoningRowForWire(row);
  if (row.kind === "toolCall") return compactToolCallRowForWire(row);
  return row;
}

export function filterConversationRowsForProfile(
  rows: readonly ConversationRow[],
  profile: DeliveryProfile,
): ConversationRow[] {
  return rows.map((row) => {
    if (row.kind !== "reasoning" || profile.reasoningDeltas) return row;
    if (row.state === "streaming") {
      // replayable 只展示思考生命周期；正文等终态 upsert 的有限预览。
      return row.text === "" ? row : { ...row, text: "" };
    }
    return compactReasoningRowForWire(row);
  });
}

/**
 * 按 profile 的 streamPaths 开关过滤 delta 序列。
 * row.delta 按流式能力过滤；结构性完整行在两个 profile 中保持同一产品事实。
 * 纯函数，不修改入参；输出保持权威日志序。
 */
export function filterConversationDeltasForProfile(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
  getRowKind: (rowId: number) => ConversationRow["kind"] | undefined = () => undefined,
): ConversationDelta[] {
  return deltas.filter((delta) => {
    if (delta.op === "row.delta") {
      // 修复原因：reasoning 与 assistantText 共用 path="text"，仅按 streamPaths 无法区分；
      // replayable 必须依赖权威 row kind 丢弃思考中间正文，同时保留回答正文。
      if (
        delta.path === "text" &&
        !profile.reasoningDeltas &&
        getRowKind(delta.rowId) === "reasoning"
      ) {
        return false;
      }
      return profile.streamPaths[delta.path];
    }
    return true;
  });
}
