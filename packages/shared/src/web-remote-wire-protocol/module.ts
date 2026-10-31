export const webRemoteWireProtocolModule = {
  id: "web-remote-wire-protocol",
  requires: [],
  provides: ["web-remote-wire-protocol"],
  publicEntrypoints: [
    "packages/shared/src/web-remote-wire-protocol/contract.ts",
    "packages/shared/src/web-remote-control-e2ee.ts",
    "packages/shared/src/web-remote-control-gzip.ts",
  ],
} as const;
