import { build } from "esbuild";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { codexWorkspaceRoot } from "./codex-runtime.mjs";

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

async function renameWithWindowsRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      // Windows 上并行 node --test 文件同时构建/执行 bridge.cjs 时，覆盖正在被读取或刚退出的
      // 目标文件会偶发返回 EPERM / EBUSY / EACCES；短暂退避重试保证原子替换完成。
      if (delayMs === undefined || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

export async function buildCodexBridge({ workspaceRoot = codexWorkspaceRoot } = {}) {
  const destination = resolve(workspaceRoot, "packages/codex-bridge/dist/bridge.cjs");
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".bridge-build-"));
  try {
    await build({
      absWorkingDir: workspaceRoot,
      entryPoints: [resolve(workspaceRoot, "packages/codex-bridge/src/main.ts")],
      outfile: join(staging, "bridge.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      sourcemap: false,
      legalComments: "eof",
      logLevel: "info",
    });
    await renameWithWindowsRetry(join(staging, "bridge.cjs"), destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await buildCodexBridge();
