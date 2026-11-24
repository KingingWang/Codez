export const mcpRuntimeModule = {
  id: "mcp-runtime",
  requires: ["codez-cli", "shared", "plugin-discovery", "live-config-watch", "plugin-host-queries"],
  provides: ["mcp-runtime"],
  publicEntrypoints: ["contract.ts", "session.ts"],
} as const;
