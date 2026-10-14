import { join, resolve } from "node:path";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import {
  codexWorkspaceRoot,
  resolveCodexTarget,
  sha256File,
  snapshotCodexBridge,
} from "./codex-runtime.mjs";
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
import { createCodexRemoteIndex } from "./codex-runtime-remote-index.mjs";

export async function ensureCodexRemoteAssets({
  bridgePath,
  root = codexRemoteRoot,
  env = process.env,
} = {}) {
  if (env.CODEZ_CODEX_REMOTE_ASSETS_READONLY === "1") {
    // Windows/macOS 重建的 server 或文件权限会改变组件 SHA；CI 消费者只能校验
    // remote-assets 生产者的原始制品，不能覆写清单后请求 Release 中不存在的文件。
    return verifyCodexRemoteAssets({ root, bridgePath, env });
  }
  bridgePath = await snapshotCodexBridge({ bridgePath: bridgePath ?? (await buildCodexBridge()) });
  const serverSha256 = await sha256File(await buildCodexRemoteServer());
  try {
    return await verifyCodexRemoteAssets({ root, serverSha256, bridgePath, env });
  } catch (error) {
    console.log(`[codex-remote-assets] preparing missing/stale bundle: ${error.message}`);
  }
  await prepareCodexRemoteAssets({ outputRoot: root, bridgePath, serverPrepared: true });
  return verifyCodexRemoteAssets({ root, serverSha256, bridgePath, env });
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
    if (targets.length === codexRemoteTargets.length) {
      const { version } = JSON.parse(
        await readFile(join(codexWorkspaceRoot, "package.json"), "utf8"),
      );
      await createCodexRemoteIndex({ root: outputRoot, version });
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
