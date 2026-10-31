// 类型从既有适配签名投影，登记本身不建立另一份制品身份或安装命令。
export type CodexReleaseRemoteAssetSource = ReturnType<
  typeof import("../remote/codexReleaseRemoteAssets.js").createCodexReleaseRemoteAssetSource
>;
export type CodexBundledRemoteAssetSource = ReturnType<
  typeof import("../remote/bundledRemoteAssets.js").createBundledRemoteAssetSource
>;
export type CodexFallbackInstaller = ReturnType<
  typeof import("../remote/codexFallbackInstaller.js").createCodexFallbackInstaller
>;
export type CodexRuntimeDeployment =
  typeof import("../remote/codexRuntimeDeploy.js").deployCodexComponents;
export type CodexRemoteRuntimeLayout = import("../remote/remoteRuntime.js").RemoteRuntimeLayout;
