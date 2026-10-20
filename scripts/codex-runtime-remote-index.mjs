import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "./codex-runtime.mjs";

export const codexRemoteTargets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const requiredCodexPaths = [
  "codex/bin/codex",
  "codex/bin/codex-code-mode-host",
  "codex/codex-package.json",
  "codex/codex-path/rg",
  "codex/bridge.cjs",
  "codex/distribution.json",
];

function validCodexPath(path) {
  return (
    /^codex\/[a-zA-Z0-9._/-]+$/.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === ".." || !segment)
  );
}

export function codexRemoteReleaseTag(env = process.env, version = "0.0.0", manifests) {
  if (/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))
    return `codez-build-${env.GITHUB_RUN_ID}-${env.GITHUB_SHA.slice(0, 12)}`;
  const hashes = codexRemoteTargets.map((target) => manifests?.[target]);
  if (hashes.some((hash) => !SHA.test(hash ?? "")))
    throw new Error("Cannot identify local Codex build without four manifest hashes");
  const identity = createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 12);
  return `codez-local-${version}-${identity}`;
}

export function remoteComponentAssetName(target, id, sha256) {
  if (!codexRemoteTargets.includes(target) || !ID.test(id) || !SHA.test(sha256))
    throw new Error("Invalid Codex remote component identity");
  return `codex-remote-${target}-${id}-${sha256}.tar.gz`;
}

export function remoteManifestAssetName(target) {
  if (!codexRemoteTargets.includes(target)) throw new Error("Invalid Codex remote target");
  return `codex-remote-manifest-${target}.json`;
}

export async function createCodexRemoteIndex({ root, version, env = process.env }) {
  const manifests = {};
  const assets = {};
  const files = {};
  for (const target of codexRemoteTargets) {
    const path = `releases/${version}/manifest-${target}.json`;
    manifests[target] = await sha256File(join(root, path));
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    for (const component of manifest.components)
      assets[component.artifactPath] = remoteComponentAssetName(
        target,
        component.id,
        component.sha256,
      );
    const contract = JSON.parse(
      await readFile(join(root, "releases", version, `runtime-${target}.json`), "utf8"),
    );
    files[target] = Object.fromEntries(
      Object.entries(contract.files).filter(([path]) => path.startsWith("codex/")),
    );
  }
  const index = {
    schemaVersion: 1,
    appVersion: version,
    releaseTag: codexRemoteReleaseTag(env, version, manifests),
    manifests,
    assets,
    files,
  };
  await writeFile(join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/** A packaged index has no archives; a producer/sidecar validates every archive too. */
export async function verifyCodexRemoteIndex({ root, version, env, includeArchives = true }) {
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  if (
    index.schemaVersion !== 1 ||
    index.appVersion !== version ||
    !/^codez-(build-[1-9][0-9]*-[a-f0-9]{12}|local-[a-zA-Z0-9._+-]+)$/.test(index.releaseTag) ||
    (env && index.releaseTag !== codexRemoteReleaseTag(env, version, index.manifests)) ||
    !index.manifests ||
    Object.keys(index.manifests).sort().join(",") !== [...codexRemoteTargets].sort().join(",") ||
    !index.assets ||
    typeof index.assets !== "object" ||
    !index.files ||
    Object.keys(index.files).sort().join(",") !== [...codexRemoteTargets].sort().join(",")
  )
    throw new Error("Invalid Codex remote release tag or index");
  const packagedFiles = ["index.json"];
  const releaseAssets = [];
  const seen = new Set();
  const seenPaths = new Set();
  for (const target of codexRemoteTargets) {
    const fileHashes = index.files[target];
    if (
      !fileHashes ||
      typeof fileHashes !== "object" ||
      !requiredCodexPaths.every((path) => SHA.test(fileHashes[path] ?? "")) ||
      Object.entries(fileHashes).some(([path, hash]) => !validCodexPath(path) || !SHA.test(hash))
    )
      throw new Error(`Invalid Codex remote file hashes: ${target}`);
    if (includeArchives) {
      const contract = JSON.parse(
        await readFile(join(root, "releases", version, `runtime-${target}.json`), "utf8"),
      );
      const current = Object.fromEntries(
        Object.entries(contract.files ?? {}).filter(([path]) => path.startsWith("codex/")),
      );
      if (JSON.stringify(current) !== JSON.stringify(fileHashes))
        throw new Error(`Codex remote file hashes disagree with producer: ${target}`);
    }
    const relative = `releases/${version}/manifest-${target}.json`;
    const expected = index.manifests[target];
    if (!SHA.test(expected) || (await sha256File(join(root, relative))) !== expected)
      throw new Error(`Codex remote manifest SHA mismatch: ${target}`);
    const manifest = JSON.parse(await readFile(join(root, relative), "utf8"));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.appVersion !== version ||
      manifest.platformArch !== target ||
      !Array.isArray(manifest.components) ||
      manifest.components.length === 0
    )
      throw new Error(`Invalid Codex remote manifest: ${target}`);
    const mounts = {
      "server-bundle": "server",
      "node-runtime": `node/${target}`,
      "node-pty": `node-pty/${target}`,
      "codex-native": "codex",
      "codex-bridge": "codex-bridge",
      ...(target.startsWith("darwin-")
        ? { ripgrep: `tools/${target}/ripgrep` }
        : Object.fromEntries(
            ["bfs", "ripgrep", "ugrep"].map((id) => [id, `tools/${target}/${id}`]),
          )),
    };
    if (
      manifest.components.length !== Object.keys(mounts).length ||
      manifest.components.some(
        ({ id, mount }) => !Object.hasOwn(mounts, id) || mount !== mounts[id],
      )
    )
      throw new Error(`Incomplete Codex remote component set: ${target}`);
    packagedFiles.push(relative);
    releaseAssets.push({ name: remoteManifestAssetName(target), path: join(root, relative) });
    for (const component of manifest.components) {
      if (
        !ID.test(component.id) ||
        !SHA.test(component.sha256) ||
        seen.has(`${target}/${component.id}`)
      )
        throw new Error(`Invalid or duplicate Codex remote component: ${target}`);
      seen.add(`${target}/${component.id}`);
      if (
        component.artifactPath !== `components/${target}/${component.id}/${component.sha256}.tar.gz`
      )
        throw new Error(`Invalid Codex remote component path: ${target}/${component.id}`);
      if (
        index.assets[component.artifactPath] !==
        remoteComponentAssetName(target, component.id, component.sha256)
      )
        throw new Error(`Codex remote component asset name mismatch: ${target}/${component.id}`);
      seenPaths.add(component.artifactPath);
      if (includeArchives) {
        const path = join(root, component.artifactPath);
        if ((await sha256File(path)) !== component.sha256)
          throw new Error(`Codex remote component SHA mismatch: ${target}/${component.id}`);
        releaseAssets.push({
          name: remoteComponentAssetName(target, component.id, component.sha256),
          path,
        });
      }
    }
  }
  if (Object.keys(index.assets).length !== seenPaths.size)
    throw new Error("Unexpected Codex remote component asset mapping");
  return { root, index, packagedFiles, releaseAssets };
}
