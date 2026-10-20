import { CodexRpcError, CodexTransportError } from "./rpc-errors.js";
import { z } from "zod";

export type BridgeFailureOrigin =
  | "startup"
  | "shutdown"
  | "host-protocol"
  | "native-transport"
  | "native-event"
  | "native-interaction"
  | "conversation-projection"
  | "sessions-index"
  | "workspace-config";

/** 生产包曾只输出笼统退出信息，无法区分第二轮投影与传输故障。
 * 仅输出固定分类/代码位置，不输出可能携带凭据、用户路径或消息 ID 的异常正文与堆栈。
 */
export function describeBridgeFailure(
  error: unknown,
  origin: BridgeFailureOrigin = "host-protocol",
): { category: string; origin: BridgeFailureOrigin; code?: number | string } {
  if (error instanceof CodexTransportError)
    return { category: "native-transport", origin, code: error.code };
  if (error instanceof CodexRpcError) return { category: "native-rpc", origin, code: error.code };
  if (error instanceof z.ZodError) return { category: "schema-validation", origin };
  const message = error instanceof Error ? error.message : "";
  const category =
    message.startsWith("Duplicate Codex item ID:") ||
    message.startsWith("Duplicate Codex item ID in turn ")
      ? "duplicate-item-id"
      : message === "Duplicate Codex thread ID in sessions index"
        ? "duplicate-thread-id"
        : "adapter-failure";
  return { category, origin };
}
