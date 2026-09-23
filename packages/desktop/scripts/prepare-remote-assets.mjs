import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopRuntime } from "./desktop-product-identity.mjs";
import { ensureCodexRemoteAssets } from "../../../scripts/codex-runtime-remote-assets.mjs";

export async function prepareDesktopRemoteAssets({
  env = process.env,
  prepareCodex = ensureCodexRemoteAssets,
  runLegacy,
} = {}) {
  if (resolveDesktopRuntime(env) === "codex") return prepareCodex();
  if (runLegacy) return runLegacy();
  const root = resolve(import.meta.dirname, "../../..");
  const child = spawn(process.execPath, [resolve(root, "scripts/prepare-prebuilds.mjs")], {
    cwd: root,
    env: { ...env, CODEZ_DESKTOP_RUNTIME: "legacy" },
    shell: false,
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`Legacy remote preparation failed (${code ?? signal})`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareDesktopRemoteAssets();
