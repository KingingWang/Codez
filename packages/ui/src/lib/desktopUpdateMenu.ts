import {
  CODEZ_PRODUCT_FLAVOR,
  type CodezProductFlavor,
  type UpdateStatePayload,
} from "@codez/shared";

// Codex 主进程已有独立的 GitHub 更新器；原条件仅放行 production，误隐藏了
// Codex 桌面的手动检查入口。Preview（含连接生产后端的 Preview）仍禁用更新器。
export function shouldShowDesktopUpdateEntry(
  flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR,
): boolean {
  return flavor === "production" || flavor === "codex";
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
