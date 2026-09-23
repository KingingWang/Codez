import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopRuntime } from "../packages/desktop/scripts/desktop-product-identity.mjs";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

function pathApiForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveProductionRemoteAssetCacheDir(
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const pathApi = pathApiForPlatform(platform);
  const product = resolveDesktopRuntime(env) === "codex" ? "Codez Codex" : "Codez";
  if (platform === "darwin") {
    return pathApi.join(homeDir, "Library", "Application Support", product, "remote-assets-cache");
  }

  if (platform === "win32") {
    const appDataDir = env.APPDATA?.trim() || pathApi.join(homeDir, "AppData", "Roaming");
    return pathApi.join(appDataDir, product, "remote-assets-cache");
  }

  const configDir = env.XDG_CONFIG_HOME?.trim() || pathApi.join(homeDir, ".config");
  return pathApi.join(configDir, product, "remote-assets-cache");
}

export function buildDesktopRemoteProdEnv(
  baseEnv = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const runtime = resolveDesktopRuntime(baseEnv);
  if (
    runtime === "codex" &&
    (baseEnv.CODEZ_DEV_REMOTE_ASSET_USE_CDN === "1" ||
      baseEnv.CODEZ_REMOTE_ASSET_CDN_BASE_URL?.trim() ||
      baseEnv.CODEZ_CDN_BASE_URL?.trim())
  ) {
    throw new Error(
      "Codex remote-prod uses verified bundled assets; legacy CDN flags/overrides are not supported. Explicit CODEZ_DESKTOP_RUNTIME=legacy retains the upstream CDN workflow.",
    );
  }
  const cacheDir =
    baseEnv.CODEZ_REMOTE_ASSET_CACHE_DIR?.trim() ||
    resolveProductionRemoteAssetCacheDir(baseEnv, platform, homeDir);

  return {
    ...baseEnv,
    CODEZ_DESKTOP_RUNTIME: runtime,
    // Codex 使用打包资源；只有显式 legacy 才复现生产 CDN 链路。
    CODEZ_ENV: "production",
    CODEZ_DEV_REMOTE_ASSET_USE_CDN: runtime === "codex" ? "0" : "1",
    // Main 是 cache 命名空间唯一所有者，避免自定义目录重复追加 codex/codex。
    CODEZ_REMOTE_ASSET_CACHE_DIR: cacheDir,
  };
}

export function resolvePnpmCommand(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function runDesktopRemoteProdDev() {
  const repoRoot = resolve(import.meta.dirname, "..");
  const child = spawn(resolvePnpmCommand(), ["--filter", "@codez/desktop", "dev"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: buildDesktopRemoteProdEnv(),
    windowsHide: true,
    ...resolveSpawnRuntimeOptions(resolvePnpmCommand()),
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[dev:desktop:remote-prod] failed to start pnpm:", error);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopRemoteProdDev();
}
