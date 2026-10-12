export const DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL =
  "https://kingingwang.github.io/Codez/remote/v4/";

/** 页面发布源由桌面发行方决定，旧入口覆盖只供未打包的本地开发使用。 */
export function resolveWebRemoteControlPageUrl(options: {
  isPackaged: boolean;
  e2eeUrl?: string;
  legacyUrl?: string;
}): string {
  return (
    options.e2eeUrl?.trim() ||
    (!options.isPackaged ? options.legacyUrl?.trim() : undefined) ||
    DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL
  );
}
