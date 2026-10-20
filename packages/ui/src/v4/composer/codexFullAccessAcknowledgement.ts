import { logger } from "@/logger.js";

const STORAGE_KEY = "codez.codex.fullAccessAcknowledged.v1";

/**
 * 完全访问（yolo）首次选择需确认；确认状态跨会话持久化
 * （specs/codex-permission-modes.md UI 约束）。
 */
export function readCodexFullAccessAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch (error) {
    // 读不到按未确认处理（fail-closed）：宁可多弹一次确认，不能跳过放权警告。
    logger.warn("[codex-full-access] 确认状态读取失败，按未确认处理", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function writeCodexFullAccessAcknowledged(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch (error) {
    // 持久化失败只影响下次是否重新弹确认，不阻断本次切换。
    logger.warn("[codex-full-access] 确认状态持久化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
