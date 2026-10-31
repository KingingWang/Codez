/** Main 能力事实的 Host 投影及单连接 broker IO 适配。 */
export const desktopNativeBrowserControlHostModule = {
  id: "desktop-native-browser-control-host",
  requires: ["shared"],
  provides: ["desktop-native-browser-control-host"],
  publicEntrypoints: [
    "contract.ts",
    "../nativeBrowserCuaMcpState.ts",
    "../nativeBrowserCuaBrokerClient.ts",
  ],
} as const;
