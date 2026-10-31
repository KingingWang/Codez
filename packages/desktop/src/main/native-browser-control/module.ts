/** Main 窗口能力 broker；Host 通过 shared 线协议调用，不拥有第二份授权。 */
export const desktopNativeBrowserControlMainModule = {
  id: "desktop-native-browser-control-main",
  requires: ["shared", "desktop"],
  provides: ["desktop-native-browser-control-main"],
  publicEntrypoints: [
    "contract.ts",
    "../browserView/nativeBrowserCuaMcpBroker.ts",
    "../desktopCodexMcpAvailability.ts",
  ],
} as const;
