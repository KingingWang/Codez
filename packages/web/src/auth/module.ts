/**
 * web-auth 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const webAuthModule = {
  id: "web-auth",
  // web-remote-native-io：fork 的 OAuth 需要 isCodezBrowserExtension 判断扩展壳运行时。
  requires: ["mobile-ui", "shared", "ui", "web-remote-native-io"],
  provides: ["web-auth"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
