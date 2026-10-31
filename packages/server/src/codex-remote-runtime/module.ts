export const codexRemoteRuntimeModule = {
  id: "codex-remote-runtime",
  requires: ["server", "shared"],
  provides: ["codex-remote-runtime"],
  publicEntrypoints: [
    "packages/server/src/codex-remote-runtime/contract.ts",
    "packages/server/src/remote/bundledRemoteAssets.ts",
    "packages/server/src/remote/codexFallbackInstaller.ts",
    "packages/server/src/remote/codexReleaseRemoteAssets.ts",
    "packages/server/src/remote/codexRuntimeDeploy.ts",
    "packages/server/src/remote/remoteRuntime.ts",
  ],
} as const;
