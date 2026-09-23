import { join, resolve } from "node:path";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { resolveCodexTarget, sha256File, snapshotCodexBridge } from "./codex-runtime.mjs";
import {
  prepareCodexRemotePackage,
  buildCodexRemoteServer,
  copyCodexRemoteServer,
} from "./codex-runtime-remote-package.mjs";
import {
  codexRemoteRoot,
  codexRemoteTargets,
  verifyCodexRemoteAssets,
} from "./codex-runtime-remote-verify.mjs";

export async function ensureCodexRemoteAssets({ bridgePath } = {}) {
  bridgePath = await snapshotCodexBridge({ bridgePath: bridgePath ?? (await buildCodexBridge()) });
  const serverSha256 = await sha256File(await buildCodexRemoteServer());
  try {
    return await verifyCodexRemoteAssets({ serverSha256, bridgePath });
  } catch (error) {
    console.log(`[codex-remote-assets] preparing missing/stale bundle: ${error.message}`);
  }
  await prepareCodexRemoteAssets({ bridgePath, serverPrepared: true });
  return verifyCodexRemoteAssets({ serverSha256, bridgePath });
}

export async function prepareCodexRemoteAssets({
  targets = codexRemoteTargets,
  bridgePath,
  serverPrepared = false,
  ...options
} = {}) {
  bridgePath = await snapshotCodexBridge({ bridgePath: bridgePath ?? (await buildCodexBridge()) });
  if (!serverPrepared) await buildCodexRemoteServer();
  const outputRoot = options.outputRoot ?? codexRemoteRoot;
  await mkdir(outputRoot, { recursive: true });
  const inputs = await mkdtemp(join(outputRoot, ".assembly-inputs-"));
  try {
    await copyCodexRemoteServer(inputs);
    const results = [];
    for (const key of targets) {
      if (!codexRemoteTargets.includes(key))
        throw new Error(`Unsupported Codex remote target: ${key}`);
      const [os, arch] = key.split("-");
      const target = resolveCodexTarget({ CODEZ_TARGET_OS: os, CODEZ_TARGET_ARCH: arch });
      console.log(`[codex-remote-assets] preparing ${key}`);
      results.push(
        await prepareCodexRemotePackage({
          ...options,
          prepareServerImpl: async (directory) => {
            for (const file of ["codez-server.cjs", "THIRD-PARTY-NOTICES.md"])
              await copyFile(join(inputs, file), join(directory, file));
          },
          target,
          stagingOptions: { bridgePath },
          publishComponents: true,
        }),
      );
    }
    return results;
  } finally {
    await rm(inputs, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((key) => !codexRemoteTargets.includes(key)))
    throw new Error("Arguments must be remote os-arch targets");
  await prepareCodexRemoteAssets(args.length ? { targets: args } : {});
}
