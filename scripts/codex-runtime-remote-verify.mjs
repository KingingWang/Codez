import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { codexWorkspaceRoot, loadCodexManifest, sha256File } from "./codex-runtime.mjs";
import { loadCodexNodeManifest } from "./codex-runtime-node.mjs";

export const codexRemoteRoot = resolve(
  codexWorkspaceRoot,
  "packages/desktop/bundled-resources/codex-remote",
);
export const codexRemoteTargets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

export async function verifyCodexRemoteAssets({
  root = codexRemoteRoot,
  bridgePath = resolve(codexWorkspaceRoot, "packages/codex-bridge/dist/bridge.cjs"),
  serverSha256,
} = {}) {
  const { version } = JSON.parse(await readFile(join(codexWorkspaceRoot, "package.json"), "utf8"));
  const native = await loadCodexManifest();
  const node = await loadCodexNodeManifest();
  const bridgeSha256 = await sha256File(bridgePath);
  const files = [];
  for (const key of codexRemoteTargets) {
    const relative = `releases/${version}/manifest-${key}.json`;
    const contractPath = `releases/${version}/runtime-${key}.json`;
    const manifest = JSON.parse(await readFile(join(root, relative), "utf8"));
    const contract = JSON.parse(await readFile(join(root, contractPath), "utf8"));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.appVersion !== version ||
      manifest.platformArch !== key
    )
      throw new Error(`Invalid remote manifest ${key}`);
    if (
      contract.deploymentContract !== "codex-components-v1" ||
      Object.hasOwn(contract, "deploymentReady") ||
      Object.hasOwn(contract, "missingConsumers") ||
      contract.files?.["codex/bridge.cjs"] !== bridgeSha256 ||
      contract.files?.["codex/codex"] !== native.assets[key].sha256 ||
      contract.node?.archiveSha256 !== node.assets[key]
    )
      throw new Error(`Stale remote runtime ${key}; regenerate Codex remote assets`);
    if (serverSha256 && contract.files?.["codez-server.cjs"] !== serverSha256)
      throw new Error(`Stale remote server ${key}; regenerate Codex remote assets`);
    const toolIds = key.startsWith("darwin-") ? ["ripgrep"] : ["bfs", "ripgrep", "ugrep"];
    const mounts = {
      "server-bundle": "server",
      "node-runtime": `node/${key}`,
      "node-pty": `node-pty/${key}`,
      "codex-runtime": "codex",
      ...Object.fromEntries(toolIds.map((id) => [id, `tools/${key}/${id}`])),
    };
    if (
      !Array.isArray(manifest.components) ||
      manifest.components.length !== Object.keys(mounts).length
    )
      throw new Error(`Incomplete remote components ${key}`);
    const seen = new Set();
    for (const component of manifest.components) {
      if (
        !Object.hasOwn(mounts, component.id) ||
        seen.has(component.id) ||
        component.mount !== mounts[component.id] ||
        !/^[a-f0-9]{64}$/.test(component.sha256) ||
        component.artifactPath !== `components/${key}/${component.id}/${component.sha256}.tar.gz`
      )
        throw new Error(`Unsafe remote component ${key}`);
      seen.add(component.id);
      if ((await sha256File(join(root, component.artifactPath))) !== component.sha256)
        throw new Error(`Remote component checksum mismatch ${key}/${component.id}`);
      files.push(component.artifactPath);
    }
    files.push(relative, contractPath);
  }
  return { root, files };
}
