/** 原生 stdio 适配边界；requires 与 architecture-policy.yaml 同步。 */
export const codexNativeSessionAdapterModule = {
  id: "codex-native-session-adapter",
  requires: ["shared", "services"],
  provides: ["codex-native-session-adapter"],
  publicEntrypoints: [
    "contract.ts",
    "../codexBridgeCommand.ts",
    "../codexBridgeTitleDiagnostic.ts",
    "../codexSessionEventProjection.ts",
  ],
} as const;
