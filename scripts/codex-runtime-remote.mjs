import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { runCodexTar } from "./codex-runtime-archive.mjs";
import {
  codexWorkspaceRoot,
  loadCodexManifest,
  resolveCodexTarget,
  sha256File,
  stageCodexRuntime,
  verifyCodexResources,
} from "./codex-runtime.mjs";

export const codexRemoteDeploymentContract = {
  deploymentContract: "codex-components-v1",
  integratedConsumers: ["component-mount", "isolated-root", "startup-env", "deployed-bridge"],
  transportValidation: { ssh: "not-run", wsl: "not-run" },
};

export async function prepareCodexRemoteComponent({
  outputRoot = resolve(codexWorkspaceRoot, "packages/desktop/bundled-resources/codex-remote"),
  target = resolveCodexTarget(),
  ...stagingOptions
} = {}) {
  if (!["darwin", "linux"].includes(target.os))
    throw new Error(
      "Remote Codex targets are darwin/linux x64/arm64; select the remote OS explicitly",
    );
  const manifest = stagingOptions.manifest ?? (await loadCodexManifest());
  const directory = await stageCodexRuntime({ ...stagingOptions, manifest, target });
  await verifyCodexResources({ directory, manifest, target });
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, ".codex-remote-"));
  try {
    const archive = join(temporary, "runtime.tar.gz");
    await runCodexTar({
      mode: "create",
      archivePath: archive,
      directory,
      entries: ["codex", "bridge.cjs", "distribution.json"],
    });
    const sha256 = await sha256File(archive);
    const artifactPath = `codex-runtime-${target.key}-${sha256}.tar.gz`;
    const metadata = JSON.parse(await readFile(join(directory, "distribution.json"), "utf8"));
    const descriptor = {
      schemaVersion: 1,
      componentId: "codex-runtime",
      platformArch: target.key,
      release: manifest.tag,
      sha256,
      artifactPath,
      mount: "codex",
      binarySha256: metadata.sha256,
      bridgeSha256: metadata.bridgeSha256,
      runtimeRoot: "~/.codez-codex/server",
      nodeVersion: "24.14.0",
      requiredEnv: {
        CODEZ_CODEX_COMMAND: "<runtimeRoot>/codex/codex",
        CODEZ_CODEX_BRIDGE_PATH: "<runtimeRoot>/codex/bridge.cjs",
        CODEZ_CODEX_BRIDGE_HOME: "~/.codez-codex/bridge",
      },
      ...codexRemoteDeploymentContract,
    };
    await writeFile(join(temporary, "component.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
    await rename(archive, join(outputRoot, artifactPath));
    await rename(
      join(temporary, "component.json"),
      join(outputRoot, `codex-runtime-${target.key}.json`),
    );
    return descriptor;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bridgePath = await buildCodexBridge();
  console.log(JSON.stringify(await prepareCodexRemoteComponent({ bridgePath }), null, 2));
}
