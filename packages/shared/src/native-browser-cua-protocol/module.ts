export const nativeBrowserCuaProtocolModule = {
  id: "native-browser-cua-protocol",
  requires: ["shared"],
  provides: ["native-browser-cua-protocol"],
  publicEntrypoints: [
    "packages/shared/src/native-browser-cua-protocol/contract.ts",
    "packages/shared/src/browser-use/nativeMcp.ts",
    "packages/shared/src/browser-use/nativeCuaMcp.ts",
  ],
} as const;
