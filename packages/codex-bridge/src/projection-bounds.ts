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
  // 原因：活跃轮次不做行缓存（projection-rows.ts:424），native-item-delta.ts:71 在原地追加
  // aggregatedOutput，于是每条 delta 都对整段累计输出重跑一次 JSON.stringify；单线程 bridge 的
  // publish drain 被拖满，RPC 只能排队（thread-state.ts:533 已记录 30s 超时）。
  // 修复依据：wireTextBytes(t) >= t.length 恒成立——JSON.stringify(t) 是引号 + escaped(t) + 引号，
  // 每个 UTF-16 码元至少贡献 1 个 UTF-8 字节（BMP 字面量 1-3；转义引号/反斜杠 2；\uXXXX 6；
  // 合法代理对 2 码元 -> 4 字节；孤立代理 -> 6 字节，或被引擎替换成 U+FFFD 时 3 字节）。
  // 因此 text.length > previewBudget 时原判断必然为假，新增的长度比较只是把本来就要走截断分支的
  // 情况短路掉，语义完全不变；实测 2 MiB 输出按 1 KiB delta 流式投影从 ~11.4s 降到 ~5.8s。
  if (text.length <= previewBudget && wireTextBytes(text) <= previewBudget) return { text };
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

/** 行预算故障码：闭合字符串，供上层做「可恢复投影故障」判定（与 attachments 的 fault code 同惯例）。 */
export const ROW_BUDGET_FAULT_CODE = "fault.projection.rowBudget";

/**
 * 单条投影行超出组装预算。
 *
 * 修复原因：这里过去抛裸 `Error`，冒泡到 `bridge-runtime.ts` 的 `conversation-projection` catch 后
 * 直接 `options.fatal` → `main.ts` `stop(true)` → `process.exitCode = 1`。超限 item 已经持久化在
 * 原生 rollout 里，于是该会话永久打不开，而且每次尝试都杀死整个 bridge 进程，连带同一窗口内
 * 其他会话一起掉线。
 * 修复依据：specs/codex-desktop-adapter.md:364-367 —— 只有 invalid JSON、invalid UTF-8、畸形信封
 * 等「resync 不可证明安全」的协议违规才允许 fatal；行预算超限是只读投影的确定性结果，没有发生
 * 任何 mutation，resync 显然安全。同 spec:392-393 又要求「A single oversized item still fails
 * explicitly」，禁止静默截断或占位改写，所以错误必须继续抛出、继续可判定，只是不再升级为进程
 * 终止；由调用方把它限定在该请求/该订阅路由内。
 * 错误正文只含原生 entityId、行类别与字节数：spec:394-396 禁止在超限诊断里出现 JSON 前缀、
 * 正文、参数或路径。
 */
export class RowBudgetExceededError extends Error {
  readonly code = ROW_BUDGET_FAULT_CODE;
  /** v4 行 schema 里 entityId 是 optional（rows.ts:21）；缺失时文案仍按原样渲染成 `undefined`。 */
  readonly entityId: string | undefined;
  readonly kind: string;
  readonly bytes: number;
  readonly budget: number;
  constructor(detail: {
    entityId: string | undefined;
    kind: string;
    bytes: number;
    budget: number;
  }) {
    // 文案必须与改动前逐字节一致：test/projection-bounds.test.ts:177-178 钉住
    // /Codex projection row .* exceeds .* bytes/，Host 侧诊断也依赖同一形状。
    super(
      `Codex projection row ${detail.entityId} (${detail.kind}) exceeds ${detail.budget} bytes: ${detail.bytes}; native content was not truncated`,
    );
    this.name = "RowBudgetExceededError";
    this.entityId = detail.entityId;
    this.kind = detail.kind;
    this.bytes = detail.bytes;
    this.budget = detail.budget;
  }
}

/** 只判定类型，不解析文案：调用方据此把行预算故障与真正的协议违规区分开。 */
export function isRowBudgetExceeded(error: unknown): error is RowBudgetExceededError {
  return error instanceof RowBudgetExceededError;
}

/** Bound individual rows, not whole native history (the caller owns paging/tail windows). */
export function assertRowBudget<T extends ConversationRow>(row: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
  if (bytes > rowBudget)
    throw new RowBudgetExceededError({
      entityId: row.entityId,
      kind: row.kind,
      bytes,
      budget: rowBudget,
    });
  return row;
}
