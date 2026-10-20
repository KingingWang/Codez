import type { RemoteAssetInstaller } from "./remoteAssetInstaller.js";
import type { DeployLoggers } from "./deployShared.js";
import { RemoteAssetSourceUnavailableError } from "./remoteAssetPreflight.js";

/** One connection owns its transport decision; both installers consume the same pinned manifest. */
export function createCodexFallbackInstaller(
  remote: RemoteAssetInstaller,
  local: RemoteAssetInstaller,
  signal?: AbortSignal,
  loggers?: Pick<DeployLoggers, "logWarn">,
): RemoteAssetInstaller {
  let sourceUnavailable = false;
  const install = async <T>(
    componentId: string,
    remoteAction: () => Promise<T>,
    localAction: () => Promise<T>,
  ) => {
    signal?.throwIfAborted();
    if (sourceUnavailable) return localAction();
    try {
      return await remoteAction();
    } catch (error) {
      if (!(error instanceof RemoteAssetSourceUnavailableError) || signal?.aborted) throw error;
      // 原因：远端下载失败后的后续组件继续探测同一个不可达源会反复超时；
      // Host 缓存与 SSH 上传沿用同一份 pinned manifest，不创建第二条制品身份写入路径。
      sourceUnavailable = true;
      loggers?.logWarn(
        `[remote-assets] remote download unavailable for ${componentId} (${error.message}); falling back to local download and SSH upload for this connection`,
      );
      signal?.throwIfAborted();
      return localAction();
    }
  };
  return {
    get mode() {
      return sourceUnavailable ? local.mode : remote.mode;
    },
    resolveComponentSha256: (id) => remote.resolveComponentSha256?.(id) ?? Promise.resolve(null),
    resolveComponentVersion: (id) => remote.resolveComponentVersion?.(id) ?? Promise.resolve(null),
    installFile: (params) =>
      install(
        params.componentId,
        () => remote.installFile(params),
        () => local.installFile(params),
      ),
    installDirectory: (params) =>
      install(
        params.componentId,
        () => remote.installDirectory(params),
        () => local.installDirectory(params),
      ),
  };
}
