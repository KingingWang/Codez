import type { CuaRuntimeSmokeInvocation } from "./contract.js";

/** 仅列出现有可选命令，不启动进程或打开真机访问开关。 */
export const helperSmokeExample = {
  entry: "e2e-helper.mjs",
  optInEnvironment: "CODEZ_CUA_HELPER_E2E",
  platform: "win32",
  desktopAccess: "read-only",
} satisfies CuaRuntimeSmokeInvocation;
