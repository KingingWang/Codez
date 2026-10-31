/** 原 source/native Key 写入适配；requires 与 architecture-policy.yaml 同步。 */
export const codexProviderKeyModule = {
  id: "codex-provider-key",
  requires: ["provider", "shared", "services"],
  provides: ["codex-provider-key"],
  publicEntrypoints: [
    "contract.ts",
    "../codexNativeProviderKey.ts",
    "../codexNativeProviderKeyService.ts",
    "../providerKeySourceService.ts",
  ],
} as const;
