/** 只描述现有 smoke 调用；没有开关时不读取桌面或执行输入。 */
export type CuaRuntimeSmokeInvocation =
  | {
      entry: "e2e-helper.mjs";
      optInEnvironment: "CODEZ_CUA_HELPER_E2E";
      platform: "win32";
      desktopAccess: "read-only";
    }
  | {
      entry: "e2e-packaged-node-repl.mjs";
      optInEnvironment: "CODEZ_CUA_PACKAGED_NODE_REPL_E2E";
      platform: "win32";
      desktopAccess: "read-only";
    }
  | {
      entry: "e2e-local.mjs";
      optInEnvironment: "CODEZ_CUA_E2E";
      platform: "desktop";
      desktopAccess: "input";
    };
