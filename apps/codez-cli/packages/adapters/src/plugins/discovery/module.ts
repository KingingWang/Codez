export const pluginDiscoveryModule = {
  id: "plugin-discovery",
  requires: ["codez-cli", "shared"],
  provides: ["plugin-discovery"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
