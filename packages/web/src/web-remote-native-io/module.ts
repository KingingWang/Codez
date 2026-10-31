export const webRemoteNativeIoModule = {
  id: "web-remote-native-io",
  requires: ["web-remote-relay"],
  provides: ["web-remote-native-io"],
  publicEntrypoints: [
    "packages/web/src/web-remote-native-io/contract.ts",
    "packages/web/src/webRemoteControlNativeSocket.ts",
  ],
} as const;
