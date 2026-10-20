import {
  PROTOCOL_V4_LIMITS as limits,
  type ConversationRow,
  type ToolCallRow,
  type ToolOutput,
} from "@codez/shared/codez-protocol-v4";

const previewBudget = limits.toolOutputFinalHeadBytes + limits.toolOutputFinalTailBytes;
// 为 60 行尾窗预留一个物理帧给信封/元数据；消息正文不能像工具预览一样静默截断。
const rowBudget = Math.floor(
  (limits.logicalFrameAssemblyMaxBytes - limits.maxFrameBytes) / limits.snapshotTailWindowRows,
);

function wireTextBytes(text: string): number {
  // 控制字符在 JSON 中膨胀（如 NUL → \\u0000），只限 UTF-8 会仍然撑爆组装预算。
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function edge(text: string, budget: number, tail = false): string {
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
    if (wireTextBytes(slice(middle)) <= budget) lower = middle;
    else upper = middle - 1;
  }
  return slice(lower);
}

function preview(text: string, kind: "input" | "output"): { text: string; totalBytes?: number } {
  if (wireTextBytes(text) <= previewBudget) return { text };
  const totalBytes = Buffer.byteLength(text, "utf8");
  const notice = kind === "input" ? "structured input omitted" : "full output unavailable";
  const marker = `\n[Codex tool ${kind} truncated; original ${totalBytes} UTF-8 bytes; ${notice}]\n`;
  return {
    text:
      edge(text, limits.toolOutputFinalHeadBytes - wireTextBytes(marker)) +
      marker +
      edge(text, limits.toolOutputFinalTailBytes, true),
    totalBytes,
  };
}

/** Pure presentation only: no full-output store or invented resolvable references. */
export function projectToolOutput(text: string): ToolOutput {
  const result = preview(text, "output");
  return {
    text: result.text,
    // 原生历史仍保存完整输出；空 ref 明确表示适配器尚无按需取全文接口，不伪造路径。
    ...(result.totalBytes === undefined
      ? {}
      : { truncated: { totalBytes: result.totalBytes, ref: "" } }),
  };
}

export function projectToolInput(input: unknown): Pick<ToolCallRow, "input" | "inputText"> {
  const text = JSON.stringify(input);
  if (text === undefined) throw new Error("Codex tool input must be JSON");
  const result = preview(text, "input");
  // 不把截断 diff/参数伪装成完整结构化输入；小输入保留原结构，大输入只展示带标记的预览。
  return { inputText: result.text, ...(result.totalBytes === undefined ? { input } : {}) };
}

/** Bound individual rows, not whole native history (the caller owns paging/tail windows). */
export function assertRowBudget<T extends ConversationRow>(row: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
  if (bytes > rowBudget)
    throw new Error(
      `Codex projection row ${row.entityId} (${row.kind}) exceeds ${rowBudget} bytes: ${bytes}; native content was not truncated`,
    );
  return row;
}
