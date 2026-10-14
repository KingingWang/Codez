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
import { quotePosixPathArg, quotePosixShellArg } from "./posixShell.js";

export const CODEX_REMOTE_REQUIRED_FILES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-package.json",
  "codex-path/rg",
  "bridge.cjs",
  "distribution.json",
];
export const CODEX_NATIVE_REQUIRED_FILES = CODEX_REMOTE_REQUIRED_FILES.filter(
  (file) => file !== "bridge.cjs" && file !== "distribution.json",
);
export const CODEX_BRIDGE_REQUIRED_FILES = ["bridge.cjs", "distribution.json"];

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
  for (const name of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"]) {
    await waitForClose(
      await backend.exec(buildRemoteChmodExecutableCommand(`${remoteDir}/${name}`)),
    );
  }
  options.signal?.throwIfAborted();
  // 安装/权限设置失败不得写成功身份；下次连接仍在原 deploy lock 内重试。
  await writeRemoteAssetComponentMeta(backend, { id: componentId, platformArch, sha256 });
}

/** Native bytes and Codez Bridge have independent identities and write paths. */
export async function deployCodexComponents(
  backend: IRemoteBackend,
  options: {
    platformArch: string;
    installer: RemoteAssetInstaller;
    force?: boolean;
    signal?: AbortSignal;
    expectedFiles?: Record<string, string>;
    verifyInstalledHashes?: boolean;
  },
  loggers: DeployLoggers,
): Promise<void> {
  const { installer, platformArch } = options;
  const nativeSha = await installer.resolveComponentSha256?.("codex-native");
  const bridgeSha = await installer.resolveComponentSha256?.("codex-bridge");
  if (!nativeSha || !bridgeSha)
    throw new Error("Codex remote manifest is missing native/bridge SHA");
  const remoteDir = `${REMOTE_BASE}/codex`;
  const nativeIdentity = await checkRemoteAssetComponentIdentity(backend, {
    componentId: "codex-native",
    platformArch,
    expectedIdentity: { sha256: nativeSha },
  });
  const nativeFilesPresent = (
    await Promise.all(
      CODEX_NATIVE_REQUIRED_FILES.map((file) => backend.exists(`${remoteDir}/${file}`)),
    )
  ).every(Boolean);
  const nativeHashesMatch =
    nativeFilesPresent &&
    options.expectedFiles &&
    (nativeIdentity.shouldDeploy || options.verifyInstalledHashes)
      ? await verifyInstalledCodexFiles(
          backend,
          Object.entries(options.expectedFiles).filter(
            ([path]) => path !== "codex/bridge.cjs" && path !== "codex/distribution.json",
          ),
        )
      : true;
  const nativeChanged = Boolean(
    options.force ||
    !nativeFilesPresent ||
    !nativeHashesMatch ||
    (nativeIdentity.shouldDeploy && !options.expectedFiles),
  );
  if (nativeChanged) {
    options.signal?.throwIfAborted();
    await installer.installDirectory({
      componentId: "codex-native",
      sourceRelativePath: "codex",
      remoteDir,
      requiredRelativePaths: CODEX_NATIVE_REQUIRED_FILES,
      forceRefresh: Boolean(options.force),
    });
    for (const file of CODEX_NATIVE_REQUIRED_FILES)
      if (!(await backend.exists(`${remoteDir}/${file}`)))
        throw new Error(`Codex native installation missing required file: ${file}`);
    for (const name of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"])
      await waitForClose(
        await backend.exec(buildRemoteChmodExecutableCommand(`${remoteDir}/${name}`)),
      );
    options.signal?.throwIfAborted();
    await writeRemoteAssetComponentMeta(backend, {
      id: "codex-native",
      platformArch,
      sha256: nativeSha,
    });
  } else {
    if (nativeIdentity.shouldDeploy)
      await writeRemoteAssetComponentMeta(backend, {
        id: "codex-native",
        platformArch,
        sha256: nativeSha,
      });
    loggers.log("Codex native SHA and required files match, skip");
  }

  const bridgeIdentity = await checkRemoteAssetComponentIdentity(backend, {
    componentId: "codex-bridge",
    platformArch,
    expectedIdentity: { sha256: bridgeSha },
  });
  const bridgeFilesPresent = (
    await Promise.all(
      CODEX_BRIDGE_REQUIRED_FILES.map((file) => backend.exists(`${remoteDir}/${file}`)),
    )
  ).every(Boolean);
  const bridgeHashesMatch =
    bridgeFilesPresent &&
    options.expectedFiles &&
    (bridgeIdentity.shouldDeploy || options.verifyInstalledHashes)
      ? await verifyInstalledCodexFiles(
          backend,
          Object.entries(options.expectedFiles).filter(
            ([path]) => path === "codex/bridge.cjs" || path === "codex/distribution.json",
          ),
        )
      : true;
  if (
    !options.force &&
    !nativeChanged &&
    bridgeFilesPresent &&
    bridgeHashesMatch &&
    (!bridgeIdentity.shouldDeploy || options.expectedFiles)
  ) {
    if (bridgeIdentity.shouldDeploy)
      await writeRemoteAssetComponentMeta(backend, {
        id: "codex-bridge",
        platformArch,
        sha256: bridgeSha,
      });
    loggers.log("Codex Bridge SHA and required files match, skip");
    return;
  }
  for (const name of CODEX_BRIDGE_REQUIRED_FILES) {
    options.signal?.throwIfAborted();
    await installer.installFile({
      componentId: "codex-bridge",
      sourceRelativePath: `codex-bridge/${name}`,
      remotePath: `${remoteDir}/${name}`,
      forceRefresh: Boolean(options.force),
    });
    if (!(await backend.exists(`${remoteDir}/${name}`)))
      throw new Error(`Codex Bridge installation missing required file: ${name}`);
  }
  options.signal?.throwIfAborted();
  await writeRemoteAssetComponentMeta(backend, {
    id: "codex-bridge",
    platformArch,
    sha256: bridgeSha,
  });
}

async function verifyInstalledCodexFiles(
  backend: IRemoteBackend,
  entries: [string, string][],
): Promise<boolean> {
  if (entries.length === 0) return false;
  if (
    entries.some(
      ([path, sha]) =>
        !/^codex\/[a-zA-Z0-9._/-]+$/.test(path) ||
        path.split("/").some((segment) => segment === "." || segment === ".." || !segment) ||
        !/^[a-f0-9]{64}$/.test(sha),
    )
  )
    return false;
  const paths = entries.map(([path]) => `${REMOTE_BASE}/${path}`);
  const code =
    "/* codex-deploy-hash */ const fs=require('node:fs'); const crypto=require('node:crypto');" +
    "(async()=>{const out=[];for(const file of process.argv.slice(1)){const hash=crypto.createHash('sha256');" +
    "for await(const chunk of fs.createReadStream(file)) hash.update(chunk);out.push(hash.digest('hex'));}" +
    "process.stdout.write(JSON.stringify(out));})().catch(()=>process.exitCode=1)";
  try {
    const stream = await backend.exec(
      `${quotePosixPathArg(`${REMOTE_BASE}/node`)} -e ${quotePosixShellArg(code)} ${paths.map(quotePosixPathArg).join(" ")}`,
    );
    let output = "";
    stream.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    await waitForClose(stream);
    const actual = JSON.parse(output) as string[];
    return (
      Array.isArray(actual) &&
      actual.length === entries.length &&
      entries.every(([, expected], index) => actual[index] === expected)
    );
  } catch {
    // 旧 Host 可能覆盖运行目录却没有更新组件 marker；无法证明文件一致就走
    // 正常内容寻址修复，不能因为 marker 仍匹配而静默运行旧原生资源。
    return false;
  }
}
