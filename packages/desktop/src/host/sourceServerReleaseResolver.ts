import { normalizeRemoteConnectionError } from "@codez/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  CODEZ_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@codez/shared";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@codez/server/remote/remoteAssetCdn.js";
import {
  buildCodexGitHubReleaseDownloadRoot,
  isCodexReleaseTag,
} from "@codez/server/remote/codexReleaseRemoteAssets.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@codez/server/remote/remoteAssetNetwork.js";
import type { ServerReleaseAsset, SourceServerProbeResult } from "@codez/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== CODEZ_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${CODEZ_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([...absolute, ...buildReleaseAssetUrlCandidates(releaseBases, relative)]),
  );
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

async function resolveRemoteDescriptor(
  remoteAssets: WindowRemoteAssetDirs,
  cacheRoot: string | null,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<ResolvedDescriptor> {
  const configuredBases =
    remoteAssets.remoteCdnBaseUrls ??
    (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []);
  const releaseBases = buildReleaseBaseCandidates(
    configuredBases.length > 0
      ? configuredBases
      : await resolveCodexPackagedReleaseBases(remoteAssets),
    CODEZ_VERSION,
  );
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  const attempts: string[] = [];
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases };
    } catch (error) {
      lastError = error;
      attempts.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8")),
      releaseBases,
    };
  }
  // 失败必须带上实际尝试的 URL 列表；此前 codex flavor 因候选为空且不记录细节，
  // 日志里只剩这一句，无法区分"没发请求"和"请求被拒"。
  const detail =
    attempts.length > 0
      ? `attempts: ${attempts.join("; ")}`
      : "no release base candidates (neither remoteCdnBaseUrls nor a valid packaged Codex release index is available)";
  throw new Error(`Unable to resolve Source Server release descriptor (${detail})`, {
    cause: lastError,
  });
}

// Bug 原因：codex flavor 的 resolveRemoteAssetDirs 只返回 packagedRemoteAssetsDir
// 与 remoteCacheDir，不带 remoteCdnBaseUrls；resolver 因此得到空候选列表，不发起
// 任何请求就抛 "Unable to resolve Source Server release descriptor"。codex 构建的
// Source Server 资产与安装包内 codex-remote/index.json 的 releaseTag 发布在同一个
// GitHub Release，所以从 build-pinned index 推导下载根即可保证版本一致。
async function resolveCodexPackagedReleaseBases(
  remoteAssets: WindowRemoteAssetDirs,
): Promise<string[]> {
  const packagedDir = remoteAssets.packagedRemoteAssetsDir?.trim();
  if (!packagedDir) return [];
  try {
    const index: unknown = JSON.parse(
      await readFile(join(packagedDir, "index.json"), "utf8"),
    );
    const releaseTag = (index as { releaseTag?: unknown } | null)?.releaseTag;
    if (!isCodexReleaseTag(releaseTag)) return [];
    return [buildCodexGitHubReleaseDownloadRoot(releaseTag)];
  } catch {
    return [];
  }
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  options: { metadataOnly?: boolean } = {},
): Promise<ServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = remoteAssets.remoteCacheDir
    ? join(remoteAssets.remoteCacheDir, "source-server", CODEZ_VERSION)
    : null;

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", CODEZ_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: CODEZ_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  if (installMode === "local-download-upload") {
    // Bug 原因：开发态曾直接信任 gitignore 的 dist-release；同版本源码变化后仍会部署旧包。
    // 现在只接受本轮 staging 写入 mock-cdn 且通过 descriptor SHA/size 校验的本地产物。
    const localReleaseDirs = remoteAssets.mockCdnDir
      ? [join(remoteAssets.mockCdnDir, "releases", CODEZ_VERSION)]
      : [];
    for (const releaseDir of localReleaseDirs) {
      const local = await resolveLocalDescriptor(releaseDir, target);
      if (!local) continue;
      return {
        localArchivePath: local.archivePath,
        target,
        version: CODEZ_VERSION,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const resolvedDescriptor = await resolveRemoteDescriptor(
    remoteAssets,
    cacheRoot,
    remoteAssetNetwork,
  );
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: CODEZ_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot)
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  return {
    localArchivePath: await downloadArchive(archive, urls, cacheRoot, remoteAssetNetwork),
    target,
    version: CODEZ_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}
