import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface BundledAgentWiring {
  CODEZ_AGENT_SERVER_COMMAND?: string;
  CODEZ_AGENT_SERVER_ARGS_JSON?: string;
  CODEZ_CODEX_BRIDGE_PATH?: string;
}

/**
 * fork 发行包把 Codex 运行时嵌入 `runtime/codex/`（bridge.cjs + bin/codex + 工具宿主）。
 * `codex/request`、`catalog/read` 只由 codex bridge 实现，随包 codez.cjs 的 app-server
 * 不认识这些方法；Host 侧只有注入 `CODEZ_CODEX_BRIDGE_PATH`（且不设
 * `CODEZ_AGENT_SERVER_COMMAND`）才会走 bridge 启动 agent。bridge 缺失时保持旧的
 * codez.cjs 接线，bridge 存在但原生可执行文件缺失时由 Host 的 resolver 明确报错。
 */
function resolvePackagedCodexBridge(runtimeDir: string): string | null {
  const bridgePath = join(runtimeDir, "codex", "bridge.cjs");
  return existsSync(bridgePath) ? bridgePath : null;
}

export function createReleaseAgentWiring(
  runtimeRoot: string,
  runtimeNode: string,
  env: Record<string, string | undefined>,
): BundledAgentWiring | null {
  if (env.CODEZ_AGENT_SERVER_COMMAND?.trim()) return null;
  if (env.CODEZ_CODEX_BRIDGE_PATH?.trim()) return null;
  const codexBridge = resolvePackagedCodexBridge(runtimeRoot);
  if (codexBridge) return { CODEZ_CODEX_BRIDGE_PATH: codexBridge };
  return {
    CODEZ_AGENT_SERVER_COMMAND: runtimeNode,
    CODEZ_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(runtimeRoot, "codez.cjs"),
      "app-server",
      "--stdio",
    ]),
  };
}

/**
 * 发行包内 Core 既不在 monorepo、也没有 Electron runtime，`codezAgentProcessManager`
 * 的默认解析链（monorepo dev → Electron → 远端已部署 binary）会全部落空。这里把随包
 * `codez.cjs` 注入为 agent 启动命令；env 覆盖是该解析链的最高优先级，因此显式配置的
 * `CODEZ_AGENT_SERVER_COMMAND` 永远优先，开发态（入口同目录无 codez.cjs）不受影响。
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.CODEZ_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  if (env.CODEZ_CODEX_BRIDGE_PATH?.trim()) {
    return null;
  }
  const bundlePath = join(entryDir, "codez.cjs");
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  const codexBridge = resolvePackagedCodexBridge(entryDir);
  if (codexBridge) return { CODEZ_CODEX_BRIDGE_PATH: codexBridge };
  return {
    CODEZ_AGENT_SERVER_COMMAND: process.execPath,
    CODEZ_AGENT_SERVER_ARGS_JSON: JSON.stringify([bundlePath, "app-server", "--stdio"]),
  };
}
