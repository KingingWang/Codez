import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CODEZ_WORKSPACE_IDENTITY_ENV } from "@codez/shared";
import type {
  CodezAgentCommand,
  CodezAgentCommandResolverContext,
} from "./codezAgentProcessManager.js";

interface CodexBridgeRuntime {
  cwd?: string;
  execPath?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function usesCodexBridgeRuntime(
  options: { desktopDefault: boolean; customCommandResolver: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CODEZ_AGENT_SERVER_COMMAND?.trim() || options.customCommandResolver) return false;
  if (env.CODEZ_DESKTOP_RUNTIME?.trim() === "legacy") return false;
  return (
    Boolean(env.CODEZ_CODEX_BRIDGE_PATH?.trim()) ||
    env.CODEZ_DESKTOP_RUNTIME?.trim() === "codex" ||
    options.desktopDefault
  );
}

/** 保持现有同步 command resolver 契约；仅探测入口，不执行构建或下载。 */
export function resolveCodexBridgeCommand(
  context: CodezAgentCommandResolverContext,
  runtime: CodexBridgeRuntime = {},
): CodezAgentCommand {
  const env = runtime.env ?? process.env;
  const resourcesPath =
    runtime.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedBridge = resourcesPath ? join(resourcesPath, "codex", "bridge.cjs") : undefined;
  const deployedBridge = env.CODEZ_CODEX_BRIDGE_PATH?.trim();
  if (deployedBridge && (!isAbsolute(deployedBridge) || !existsSync(deployedBridge))) {
    throw new Error(
      `CODEZ_CODEX_BRIDGE_PATH must point to an existing absolute bridge path: ${deployedBridge}`,
    );
  }
  let bridge =
    deployedBridge || (packagedBridge && existsSync(packagedBridge) ? packagedBridge : undefined);
  const packaged = !deployedBridge && bridge !== undefined;
  let directory = runtime.cwd ?? process.cwd();
  while (!bridge) {
    const candidate = join(directory, "packages", "codex-bridge", "dist", "bridge.cjs");
    if (existsSync(candidate)) {
      bridge = candidate;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!bridge) {
    throw new Error(
      "Codez Codex bridge missing. Run node scripts/build-codex-bridge.mjs or reinstall the packaged app.",
    );
  }
  const nativeOverride = env.CODEZ_CODEX_COMMAND?.trim();
  const native =
    nativeOverride ||
    (packaged || deployedBridge
      ? join(
          dirname(bridge),
          (runtime.platform ?? process.platform) === "win32" ? "codex.exe" : "codex",
        )
      : "codex");
  if ((packaged || deployedBridge) && !nativeOverride && !existsSync(native)) {
    throw new Error(`Codex executable missing: ${native}. Reinstall the packaged app.`);
  }
  // 原生 Codex 不认识 --surface/--prepare-storage；只把可执行文件交给独立 bridge。
  return {
    command: runtime.execPath ?? process.execPath,
    args: [bridge],
    cwd: context.workspacePath,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      CODEZ_CODEX_COMMAND: native,
      // process.cwd() 可能变成物理路径；Host 的本地 path-fallback key 不能随之变化。
      [CODEZ_WORKSPACE_IDENTITY_ENV]: context.workspaceKey,
    },
  };
}
