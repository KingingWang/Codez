import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  commitStagingDirectoryAtomically,
  computeFileSha256,
  parseRemoteAssetManifestFromResponse,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifestComponent,
  type RemoteAssetManifestRef,
} from "./remoteAssetCache.js";
import { extractTarGzArchive } from "./localTarGz.js";
import type { DeployLoggers } from "./deployShared.js";

const READY = ".bundled-ready";
const materializations = new Map<string, Promise<string>>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** 仅适配本地随包归档；输出仍由既有 LocalUploadAssetInstaller 消费。 */
export function createBundledRemoteAssetSource(
  options: {
    bundledRemoteAssetsDir: string;
    remoteCacheDir: string;
    version: string;
    platformArch: string;
  },
  loggers: DeployLoggers,
) {
  const { version, platformArch } = options;
  if (
    !/^(linux|darwin)-(x64|arm64)$/.test(platformArch) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)
  ) {
    throw new Error("Invalid bundled remote target or version");
  }
  if (!isAbsolute(options.bundledRemoteAssetsDir) || !isAbsolute(options.remoteCacheDir)) {
    throw new Error(
      "Bundled remote assets require absolute bundledRemoteAssetsDir and remoteCacheDir",
    );
  }
  const root = resolve(options.bundledRemoteAssetsDir);
  let manifestPromise: Promise<RemoteAssetManifestRef> | undefined;
  const readManifest = (): Promise<RemoteAssetManifestRef> =>
    (manifestPromise ??= (async () => {
      const path = join(root, "releases", version, `manifest-${platformArch}.json`);
      const manifest = await parseRemoteAssetManifestFromResponse(
        new Response(await readFile(path, "utf8")),
        path,
        version,
        platformArch,
      );
      for (const component of manifest.components) {
        requiredFiles(component, platformArch);
        if (
          component.artifactPath !==
          `components/${platformArch}/${component.id}/${component.sha256}.tar.gz`
        ) {
          throw new Error(`Invalid bundled remote artifact path: ${component.artifactPath}`);
        }
      }
      return { manifest, releaseBaseCandidatesForComponents: [] };
    })());

  return {
    readManifest,
    async materialize(componentIds?: string[], forceRefresh = false): Promise<string> {
      const ref = await readManifest();
      const components = selectRemoteAssetManifestComponents(ref.manifest, componentIds);
      // codex mount 固定为 codex，缓存身份不能只用 mount 或版本，必须包含远端 target 和全部制品 SHA。
      const destination = join(
        options.remoteCacheDir,
        "bundled",
        version,
        platformArch,
        digest(JSON.stringify(ref.manifest)),
        digest(JSON.stringify(components)),
      );
      const key = `${root}\0${destination}`;
      const existing = materializations.get(key);
      if (existing) return existing;
      const task = (async () => {
        const canonicalRoot = await realpath(root);
        const archives = new Map<string, string>();
        // warm cache 也校验随包 SHA；坏包不得因为历史缓存可用而被静默接受。
        for (const component of components) {
          const archive = await realpath(join(root, component.artifactPath));
          const path = relative(canonicalRoot, archive);
          if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
            throw new Error("Bundled archive escapes its root");
          if ((await computeFileSha256(archive)) !== component.sha256)
            throw new Error(`Bundled archive sha256 mismatch: ${component.id}`);
          archives.set(component.id, archive);
        }
        if (!forceRefresh && (await validCache(destination))) return destination;
        const stagingRoot = join(options.remoteCacheDir, "bundled-staging");
        await mkdir(stagingRoot, { recursive: true });
        const staging = await mkdtemp(join(stagingRoot, `${platformArch}-`));
        const release = join(staging, "release");
        await mkdir(release);
        try {
          for (const component of components) {
            const archive = join(staging, `${component.id}.tar.gz`);
            await copyFile(archives.get(component.id)!, archive);
            // 校验实际解包的副本，阻断原归档在初检与 copy 之间变化的窗口。
            if ((await computeFileSha256(archive)) !== component.sha256)
              throw new Error(`Bundled archive sha256 mismatch: ${component.id}`);
            const mount = join(release, component.mount);
            await extractTarGzArchive(archive, mount);
            for (const file of requiredFiles(component, platformArch)) {
              if (!(await lstat(join(mount, file))).isFile())
                throw new Error(`Invalid bundled remote file: ${component.id}/${file}`);
            }
          }
          await writeFile(
            join(release, `manifest-${platformArch}.json`),
            JSON.stringify(ref.manifest),
          );
          await writeFile(join(release, READY), await treeDigest(release));
          await commitStagingDirectoryAtomically(release, destination);
          loggers.log(
            `bundled remote materialized: ${platformArch} ${components.map((c) => c.id).join(",")}`,
          );
          return destination;
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      })();
      materializations.set(key, task);
      try {
        return await task;
      } finally {
        if (materializations.get(key) === task) materializations.delete(key);
      }
    },
  };
}

function requiredFiles(component: RemoteAssetManifestComponent, target: string): string[] {
  switch (component.id) {
    case "server-bundle":
      return ["codez-server.cjs"];
    case "node-runtime":
      return ["node"];
    case "node-pty":
      return target.startsWith("darwin-") ? ["pty.node", "spawn-helper"] : ["pty.node"];
    case "codex-runtime":
      return ["codex", "bridge.cjs", "distribution.json"];
    case "bfs":
      return ["bfs"];
    case "ripgrep":
      return ["rg"];
    case "ugrep":
      return ["ugrep"];
    default:
      throw new Error(`Unsupported bundled remote component: ${component.id}`);
  }
}

async function validCache(directory: string): Promise<boolean> {
  try {
    return (await readFile(join(directory, READY), "utf8")) === (await treeDigest(directory));
  } catch {
    return false;
  }
}

async function treeDigest(directory: string): Promise<string> {
  const records: string[] = [];
  async function visit(path: string, prefix: string) {
    if (!(await lstat(path)).isDirectory()) throw new Error("Invalid bundled cache directory");
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!prefix && entry.name === READY) continue;
      const file = join(path, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(file, `${name}/`);
      else if (entry.isFile())
        records.push(
          JSON.stringify([name, (await lstat(file)).mode & 0o777, await computeFileSha256(file)]),
        );
      else throw new Error(`Unsupported bundled cache entry: ${name}`);
    }
  }
  await visit(directory, "");
  return digest(records.join("\n"));
}
