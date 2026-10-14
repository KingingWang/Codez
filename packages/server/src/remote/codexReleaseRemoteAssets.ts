import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  computeFileSha256,
  parseRemoteAssetManifestFromResponse,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifestComponent,
  type RemoteAssetManifestRef,
} from "./remoteAssetCache.js";
import { createBundledRemoteAssetSource } from "./bundledRemoteAssets.js";
import { resolveRemoteAssetFetch, type RemoteAssetNetworkPort } from "./remoteAssetNetwork.js";
import type { DeployLoggers } from "./deployShared.js";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const shaPattern = /^[a-f0-9]{64}$/;
const tagPattern = /^codez-(?:build-[1-9][0-9]*-[a-f0-9]{12}|local-[a-zA-Z0-9._+-]+)$/;
const targets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const inFlightDownloads = new Map<
  string,
  {
    promise: Promise<string>;
    controller: AbortController;
    waiters: Set<symbol>;
  }
>();
const requiredCodexPaths = [
  "codex/bin/codex",
  "codex/bin/codex-code-mode-host",
  "codex/codex-package.json",
  "codex/codex-path/rg",
  "codex/bridge.cjs",
  "codex/distribution.json",
];

interface CodexReleaseIndex {
  schemaVersion: 1;
  appVersion: string;
  releaseTag: string;
  manifests: Record<string, string>;
  assets: Record<string, string>;
  files: Record<string, Record<string, string>>;
}

export function createCodexReleaseRemoteAssetSource(
  options: {
    packagedRemoteAssetsDir: string;
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
    signal?: AbortSignal;
  },
  loggers: DeployLoggers,
) {
  if (
    !targets.includes(options.platformArch) ||
    !isAbsolute(options.packagedRemoteAssetsDir) ||
    !isAbsolute(options.remoteCacheDir) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(options.version)
  )
    throw new Error("Invalid packaged Codex remote source");

  let snapshotPromise:
    | Promise<{
        index: CodexReleaseIndex;
        indexBytes: Buffer;
        manifest: RemoteAssetManifestRef;
      }>
    | undefined;
  const snapshot = () =>
    (snapshotPromise ??= (async () => {
      const indexBytes = await readFile(join(options.packagedRemoteAssetsDir, "index.json"));
      const index = JSON.parse(indexBytes.toString("utf8")) as CodexReleaseIndex;
      const fileHashes = index.files?.[options.platformArch];
      if (
        index.schemaVersion !== 1 ||
        index.appVersion !== options.version ||
        !tagPattern.test(index.releaseTag) ||
        !index.manifests ||
        Object.keys(index.manifests).sort().join(",") !== [...targets].sort().join(",") ||
        !index.assets ||
        typeof index.assets !== "object" ||
        !fileHashes ||
        !requiredCodexPaths.every((path) => shaPattern.test(fileHashes[path] ?? "")) ||
        Object.entries(fileHashes).some(
          ([path, sha]) =>
            !/^codex\/[a-zA-Z0-9._/-]+$/.test(path) ||
            path.split("/").some((segment) => segment === "." || segment === ".." || !segment) ||
            !shaPattern.test(sha),
        )
      )
        throw new Error("Invalid packaged Codex remote release index");
      const relative = `releases/${options.version}/manifest-${options.platformArch}.json`;
      const bytes = await readFile(join(options.packagedRemoteAssetsDir, relative));
      const expectedManifestSha = index.manifests[options.platformArch];
      if (
        typeof expectedManifestSha !== "string" ||
        !shaPattern.test(expectedManifestSha) ||
        digest(bytes) !== expectedManifestSha
      )
        throw new Error("Packaged Codex remote manifest SHA mismatch");
      const manifest = await parseRemoteAssetManifestFromResponse(
        new Response(bytes),
        relative,
        options.version,
        options.platformArch,
      );
      for (const component of manifest.components) {
        if (
          component.artifactPath !==
            `components/${options.platformArch}/${component.id}/${component.sha256}.tar.gz` ||
          index.assets[component.artifactPath] !==
            `codex-remote-${options.platformArch}-${component.id}-${component.sha256}.tar.gz`
        )
          throw new Error("Packaged Codex remote component mapping mismatch");
      }
      return {
        index,
        indexBytes,
        manifest: {
          manifest,
          releaseBaseCandidatesForComponents: [
            `https://github.com/KingingWang/Codez/releases/download/${index.releaseTag}`,
          ],
        },
      };
    })());

  const artifactUrl = async (component: RemoteAssetManifestComponent): Promise<string> => {
    const { index } = await snapshot();
    const name = index.assets[component.artifactPath];
    if (!name) throw new Error(`Missing pinned Codex release asset: ${component.id}`);
    return `https://github.com/KingingWang/Codez/releases/download/${index.releaseTag}/${name}`;
  };

  const archivePath = async (component: RemoteAssetManifestComponent): Promise<string> => {
    const { index, indexBytes } = await snapshot();
    const localArchive = join(options.packagedRemoteAssetsDir, component.artifactPath);
    if (await isFile(localArchive)) {
      if ((await computeFileSha256(localArchive)) !== component.sha256)
        throw new Error(`Packaged Codex remote component SHA mismatch: ${component.id}`);
      return localArchive;
    }
    const imported = join(
      options.remoteCacheDir,
      "imports",
      index.releaseTag,
      component.artifactPath,
    );
    if (await isFile(imported)) {
      const importedIndex = await readFile(
        join(options.remoteCacheDir, "imports", index.releaseTag, "index.json"),
      );
      if (digest(importedIndex) !== digest(indexBytes))
        throw new Error("Imported Codex remote index does not match the installed build");
      if ((await computeFileSha256(imported)) !== component.sha256)
        throw new Error(`Imported Codex remote component SHA mismatch: ${component.id}`);
      return imported;
    }
    const cached = join(options.remoteCacheDir, "downloads", `${component.sha256}.tar.gz`);
    if (await isFile(cached)) {
      if ((await computeFileSha256(cached)) !== component.sha256)
        throw new Error(`Cached Codex remote component SHA mismatch: ${component.id}`);
      return cached;
    }
    options.signal?.throwIfAborted();
    return downloadAndCacheComponent({
      cached,
      component,
      platformArch: options.platformArch,
      remoteAssetNetwork: options.remoteAssetNetwork,
      resolveUrl: () => artifactUrl(component),
      signal: options.signal,
      loggers,
    });
  };

  return {
    readManifest: async (): Promise<RemoteAssetManifestRef> => (await snapshot()).manifest,
    expectedCodexFiles: async (): Promise<Record<string, string>> =>
      (await snapshot()).index.files[options.platformArch]!,
    artifactUrls: async (component: RemoteAssetManifestComponent): Promise<string[]> => [
      await artifactUrl(component),
    ],
    async materialize(componentIds?: string[], forceRefresh = false): Promise<string> {
      const { index, manifest } = await snapshot();
      const selected = selectRemoteAssetManifestComponents(manifest.manifest, componentIds);
      const root = join(options.remoteCacheDir, "release-sources", index.releaseTag);
      const relative = `releases/${options.version}/manifest-${options.platformArch}.json`;
      const manifestDestination = join(root, relative);
      await publishVerifiedCopy(
        join(options.packagedRemoteAssetsDir, relative),
        manifestDestination,
        index.manifests[options.platformArch]!,
        options.signal,
      );
      for (const component of selected) {
        const destination = join(root, component.artifactPath);
        await publishVerifiedCopy(
          await archivePath(component),
          destination,
          component.sha256,
          options.signal,
        );
      }
      return createBundledRemoteAssetSource(
        {
          bundledRemoteAssetsDir: root,
          remoteCacheDir: options.remoteCacheDir,
          version: options.version,
          platformArch: options.platformArch,
        },
        loggers,
      ).materialize(componentIds, forceRefresh);
    },
  };
}

async function downloadAndCacheComponent(options: {
  cached: string;
  component: RemoteAssetManifestComponent;
  platformArch: string;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
  resolveUrl: () => Promise<string>;
  signal?: AbortSignal;
  loggers: DeployLoggers;
}): Promise<string> {
  const { cached, component } = options;
  const waiter = Symbol(component.id);
  let task = inFlightDownloads.get(cached);
  if (!task) {
    const controller = new AbortController();
    const waiters = new Set<symbol>();
    const promise = (async () => {
      const parent = dirname(cached);
      await mkdir(parent, { recursive: true });
      const temporary = join(parent, `.download-${randomUUID()}.tar.gz`);
      try {
        const response = await resolveRemoteAssetFetch(options.remoteAssetNetwork)(
          await options.resolveUrl(),
          {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
          },
        );
        if (!response.ok || !response.body)
          throw new Error(`Codex remote release download HTTP ${response.status}: ${component.id}`);
        let bytes = 0;
        await pipeline(
          Readable.fromWeb(response.body),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              callback(
                bytes > 1_073_741_824 ? new Error("Codex remote archive too large") : null,
                chunk,
              );
            },
          }),
          createWriteStream(temporary, { flags: "wx" }),
          { signal: controller.signal },
        );
        if ((await computeFileSha256(temporary)) !== component.sha256)
          throw new Error(`Codex remote release component SHA mismatch: ${component.id}`);
        controller.signal.throwIfAborted();
        await publishDownloadedArchive(temporary, cached, component.sha256);
        options.loggers.log(
          `cached Codex remote component: ${options.platformArch}/${component.id}`,
        );
        return cached;
      } finally {
        await rm(temporary, { force: true });
      }
    })().finally(() => {
      if (inFlightDownloads.get(cached)?.promise === promise) inFlightDownloads.delete(cached);
    });
    task = { promise, controller, waiters };
    inFlightDownloads.set(cached, task);
  }
  task.waiters.add(waiter);
  return awaitWithCallerSignal(task.promise, options.signal, () => {
    task.waiters.delete(waiter);
    // 只有所有等待者都取消时才中止底层共享下载，避免一条连接取消打断另一条正在等待的连接。
    if (task.waiters.size === 0) task.controller.abort(options.signal?.reason);
  });
}

async function publishDownloadedArchive(
  temporary: string,
  cached: string,
  expectedSha: string,
): Promise<void> {
  const verifyCached = async (): Promise<boolean> => {
    if (!(await isFile(cached))) return false;
    if ((await computeFileSha256(cached)) !== expectedSha)
      throw new Error(`Cached Codex remote component SHA mismatch: ${cached}`);
    return true;
  };
  if (await verifyCached()) return;
  try {
    await rename(temporary, cached);
  } catch (error) {
    if (!(await verifyCached())) throw error;
  }
}

async function awaitWithCallerSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onCleanup: () => void,
): Promise<T> {
  if (!signal) {
    try {
      return await promise;
    } finally {
      onCleanup();
    }
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      onCleanup();
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    onCleanup();
  }
}

async function publishVerifiedCopy(
  source: string,
  destination: string,
  expectedSha: string,
  signal?: AbortSignal,
): Promise<void> {
  const verifyPublished = async (): Promise<boolean> => {
    if (!(await isFile(destination))) return false;
    if ((await computeFileSha256(destination)) !== expectedSha)
      throw new Error(`Codex remote source SHA mismatch: ${destination}`);
    return true;
  };
  signal?.throwIfAborted();
  if (await verifyPublished()) return;
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.new-${randomUUID()}`;
  try {
    // 同一 build 的多条 SSH 连接可能同时 materialize；先校验独立 staging，再原子发布。
    await copyFile(source, staging);
    if ((await computeFileSha256(staging)) !== expectedSha)
      throw new Error(`Codex remote source SHA mismatch: ${destination}`);
    signal?.throwIfAborted();
    if (await verifyPublished()) return;
    try {
      await rename(staging, destination);
    } catch (error) {
      // Windows 不允许覆盖另一连接刚发布的同名文件；内容正确即可复用。
      if (!(await verifyPublished())) throw error;
    }
  } finally {
    await rm(staging, { force: true });
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
