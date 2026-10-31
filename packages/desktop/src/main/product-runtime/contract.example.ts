import {
  resolveCodexGitHubUpdateFeedOptions,
  resolveCodexRemoteAssetDirs,
  resolveDesktopApplicationName,
  resolveDesktopBootstrapSettingsFile,
  resolveDesktopDataBaseDir,
  resolveDesktopUpdatePolicy,
} from "../desktopProductRuntime.js";
import type { DesktopProductRuntimePort } from "./contract.js";

/** 同一实现供 bootstrap/deep-link/updater/remote resolver 使用；不另存 flavor 状态。 */
export const desktopProductRuntimeExample = {
  resolveDesktopApplicationName,
  resolveDesktopDataBaseDir,
  resolveDesktopBootstrapSettingsFile,
  resolveDesktopUpdatePolicy,
  resolveCodexGitHubUpdateFeedOptions,
  resolveCodexRemoteAssetDirs,
} satisfies DesktopProductRuntimePort;
