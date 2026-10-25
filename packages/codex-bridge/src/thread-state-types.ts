import type { NativeTurnUsageAccumulator } from "./bridge-snapshot-usage.js";
import type { TurnAutoApprovalReviewsMap } from "./auto-approval-review.js";
import type { JsonObject } from "./json.js";
import type { NativeRetryState } from "./native-retry-status.js";
import { CodexRpcError } from "./rpc-errors.js";
import type { SelectionSideChatBoundary } from "./selection-side-chat.js";

export class DeletedThreadError extends Error {
  constructor() {
    super("Thread was deleted; refresh the session list");
  }
}

/** Codex 写锁冲突签名（rollout/writer_lock.rs：InvalidRequest + 固定文案），两者同时匹配才算冲突。 */
export function isWriterConflictError(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    error.message.includes("already has an active writer")
  );
}

export interface ThreadProjectionState {
  thread: JsonObject;
  queue: unknown[];
  revision: number;
  seq: number;
  epoch: string;
  apiRetry: NativeRetryState;
  /** writer-conflict：另一进程持有该线程写锁，投影为只读降级；恢复需 invalidate 后重新 load。 */
  /** subagent-child：子代理线程永远只读（原生 V2 子线程不接受客户端直接输入）。 */
  readOnly?: "writer-conflict" | "subagent-child";
  /** resume 是否成功 attach 到原生线程：只有 attach 才有子线程实时 item 流。 */
  attached?: boolean;
  /** subagents 投影的语义指纹与 revision（specs/codex-desktop-subagent-drilldown.md）。 */
  subagents?: { revision: number; semantic: string };
  /** 辅助对话 child 的继承裁剪边界（spec: codex-selection-side-chat）；load 时按父线程求交重建。 */
  sideChat?: SelectionSideChatBoundary;
  /** 按 turnId 记录的单轮原生 tokenUsage 累计快照，用于投影每轮 turnUsage。 */
  turnTokenUsage?: Record<string, NativeTurnUsageAccumulator>;
  /** 按 turnId -> reviewId 记录的 Codex Guardian 自动审批运行态投影事实。 */
  autoApprovalReviews?: TurnAutoApprovalReviewsMap;
  /** 原生 Codex 线程目标（thread/goal/get | thread/goal/set | thread/goal/updated）。 */
  goal?: JsonObject | null;
}
