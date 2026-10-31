/** 既有 grant/relay/managed-skill 适配；requires 与 architecture-policy.yaml 同步。 */
export const codexNativeControlAdapterModule = {
  id: "codex-native-control-adapter",
  requires: ["shared", "services", "rpc", "codez-cua"],
  provides: ["codex-native-control-adapter"],
  publicEntrypoints: [
    "contract.ts",
    "../cuaCredentialGrantPublisher.ts",
    "../desktopBrowserRelay.ts",
    "../../plugins/codexNativeCuaSkill.ts",
  ],
} as const;
