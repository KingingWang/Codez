import type * as UpdateMenu from "@/lib/desktopUpdateMenu.js";

/** updater 的只读菜单投影，不提供下载、安装或重启命令。 */
export interface DesktopUpdatePresentationContract {
  readonly shouldShowDesktopUpdateEntry: typeof UpdateMenu.shouldShowDesktopUpdateEntry;
  readonly getUpdateMenuLabelId: typeof UpdateMenu.getUpdateMenuLabelId;
  readonly getUpdateMenuLabelValues: typeof UpdateMenu.getUpdateMenuLabelValues;
}
