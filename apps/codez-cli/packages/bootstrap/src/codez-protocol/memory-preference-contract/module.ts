/** Host 偏好到 resident CLI runtime 的既有合成端口。 */
export const cliMemoryPreferencesModule = {
  id: "cli-memory-preferences",
  requires: ["codez-cli", "shared"],
  provides: ["host-memory-preferences"],
  publicEntrypoints: ["contract.ts"],
} as const;
