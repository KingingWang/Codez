/** 原文件回退 adapter；requires 与 architecture-policy.yaml 同步。 */
export const codexFileRewindModule = {
  id: "codex-file-rewind",
  requires: ["shared", "services"],
  provides: ["codex-file-rewind"],
  publicEntrypoints: [
    "contract.ts",
    "../desktop-file-rewind.ts",
    "../desktop-file-rewindService.ts",
  ],
} as const;
