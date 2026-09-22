import type { IRemoteBackend, RemoteEnvironment } from "./backend.js";
import {
  REMOTE_BASE,
  buildRemoteChmodExecutableCommand,
  waitForClose,
  type DeployLoggers,
} from "./deployShared.js";
import type { RemoteAssetInstaller } from "./remoteAssetInstaller.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "./remoteAssetLiveIdentity.js";
import { quotePosixPathArg } from "./posixShell.js";

export const CODEX_REMOTE_REQUIRED_FILES = ["codex", "bridge.cjs", "distribution.json"];

export function assertCodexRemoteEnvironment(env: RemoteEnvironment): void {
  if (!["linux", "darwin"].includes(env.platform) || !["x64", "arm64"].includes(env.arch)) {
    throw new Error(`Unsupported Codex remote target: ${env.platform}-${env.arch}`);
  }
}

export async function assertCodexRemoteNodeVersion(backend: IRemoteBackend): Promise<void> {
  const stream = await backend.exec(`${quotePosixPathArg(`${REMOTE_BASE}/node`)} --version`);
  let output = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  await waitForClose(stream);
  // component.version 可采用内容 SHA；不能把它当 Node 版本，必须验证实际可执行文件。
  if (output.trim() !== "v24.14.0") {
    throw new Error(
      `Codex remote requires Node v24.14.0; received ${JSON.stringify(output.trim())}`,
    );
  }
}

export async function deployCodexRuntime(
  backend: IRemoteBackend,
  options: {
    platformArch: string;
    installer: RemoteAssetInstaller;
    force?: boolean;
    signal?: AbortSignal;
  },
  loggers: DeployLoggers,
): Promise<void> {
  options.signal?.throwIfAborted();
  const { installer, platformArch } = options;
  const componentId = "codex-runtime";
  const sha256 = await installer.resolveComponentSha256?.(componentId);
  if (!sha256) throw new Error("Codex remote manifest is missing codex-runtime SHA");
  const remoteDir = `${REMOTE_BASE}/codex`;
  const identity = await checkRemoteAssetComponentIdentity(backend, {
    componentId,
    platformArch,
    expectedIdentity: { sha256 },
  });
  const filesPresent = (
    await Promise.all(
      CODEX_REMOTE_REQUIRED_FILES.map((file) => backend.exists(`${remoteDir}/${file}`)),
    )
  ).every(Boolean);
  if (!options.force && !identity.shouldDeploy && filesPresent) {
    loggers.log("Codex runtime SHA and required files match, skip");
    return;
  }
  await installer.installDirectory({
    componentId,
    sourceRelativePath: "codex",
    remoteDir,
    requiredRelativePaths: CODEX_REMOTE_REQUIRED_FILES,
    forceRefresh: Boolean(options.force),
  });
  options.signal?.throwIfAborted();
  for (const file of CODEX_REMOTE_REQUIRED_FILES) {
    if (!(await backend.exists(`${remoteDir}/${file}`))) {
      throw new Error(`Codex remote installation missing required file: ${file}`);
    }
  }
  await waitForClose(await backend.exec(buildRemoteChmodExecutableCommand(`${remoteDir}/codex`)));
  options.signal?.throwIfAborted();
  // 安装/权限设置失败不得写成功身份；下次连接仍在原 deploy lock 内重试。
  await writeRemoteAssetComponentMeta(backend, { id: componentId, platformArch, sha256 });
}
