import { build } from "esbuild";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexWorkspaceRoot } from "./codex-runtime.mjs";

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
    await rename(join(staging, "bridge.cjs"), destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await buildCodexBridge();
