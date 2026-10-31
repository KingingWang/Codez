export const codexNativeProtocolModule = {
  id: "codex-native-protocol",
  requires: [],
  provides: ["codex-native-protocol"],
  publicEntrypoints: [
    "packages/shared/src/codex-native-protocol/contract.ts",
    "packages/shared/src/codex-runtime.ts",
    "packages/shared/src/codex-native-provider-key.ts",
  ],
} as const;
