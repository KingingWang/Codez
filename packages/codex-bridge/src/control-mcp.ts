import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import * as s from "@codez/shared";
import { codezMcpListResultSchema, type CodezMcpServerStatusSnapshot } from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { assertNotSymlink, writeFileAtomic } from "./control-agents-data.js";
import { ControlError, readConfig, readPages, unsupported } from "./control-common.js";

const statusSchema = z.object({
  name: z.string().min(1),
  tools: z.record(z.string(), z.unknown()),
  toolsError: z.string().nullable(),
  runtimeStatus: z
    .enum([
      "notStarted",
      "starting",
      "connected",
      "authenticationRequired",
      "failed",
      "cancelled",
      "disabled",
    ])
    .nullable(),
});

export async function readControlMcp(context: BridgeControlContext) {
  const [config, servers] = await Promise.all([
    readConfig(context),
    readPages(context, "mcpServerStatus/list", statusSchema, { detail: "toolsAndAuthOnly" }),
  ]);
  const statuses: Record<string, CodezMcpServerStatusSnapshot> = {};
  for (const server of servers) {
    const configured = config.mcp_servers?.[server.name];
    const transport = configured?.command ? "stdio" : configured?.url ? "http" : undefined;
    if (!transport) unsupported("mcp/list", `Codex did not expose transport for ${server.name}`);
    const status =
      configured?.enabled === false || server.runtimeStatus === "disabled"
        ? "disabled"
        : server.toolsError ||
            server.runtimeStatus === "failed" ||
            server.runtimeStatus === "authenticationRequired"
          ? "failed"
          : server.runtimeStatus === "connected"
            ? "connected"
            : server.runtimeStatus === "starting"
              ? "connecting"
              : "disconnected";
    statuses[server.name] = {
      status,
      transport,
      toolCount: Object.keys(server.tools).length,
      updatedAt: new Date().toISOString(),
      ...(server.toolsError
        ? { error: server.toolsError, failureKind: "tool_list_failed" as const }
        : {}),
      ...(server.runtimeStatus === "authenticationRequired"
        ? { failureKind: "not_authenticated" as const }
        : {}),
      ...(server.runtimeStatus === null ? { failureKind: "status_unavailable" as const } : {}),
    };
  }
  return codezMcpListResultSchema.parse({ statuses });
}

// ---------------------------------------------------------------------------
// mcp/projectConfigWrite（spec: specs/codex-desktop-mcp-settings.md）
// 原生 config/batchWrite 只允许写 user 层（configLayerReadonly）；项目层
// .codex/config.toml 由 bridge 在 workspace 所属机器上直接 read-modify-write，
// 随后 config/mcpServer/reload 生效。远程 workspace 的 bridge 就在远端机器上，
// 因此远程项目天然走同一路径。
// ---------------------------------------------------------------------------

const projectLayerScanSchema = z.object({
  layers: z
    .array(
      z
        .object({
          name: z.object({ type: z.string(), dotCodexFolder: z.string().optional() }),
        })
        .passthrough(),
    )
    .optional(),
});

// 与 config/batchWrite keyPath 的 TOML 裸键口径一致（对照 codexProviderSettings 的
// provider id 规则）；不合规名称在 GUI 只读展示，不由本方法写入。
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

async function resolveProjectConfigFile(
  context: BridgeControlContext,
  method: string,
  dotCodexFolder?: string,
): Promise<{ configFilePath: string; projectRoot: string }> {
  const scan = projectLayerScanSchema.parse(
    await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: true }),
  );
  // project 层按「最近者优先」排列（Codex 0.157 实测）；缺省写最近一层。
  const projectLayers = (scan.layers ?? []).filter(
    (layer) => layer.name.type === "project" && layer.name.dotCodexFolder,
  );
  let folder: string;
  if (dotCodexFolder !== undefined) {
    // UI 可经 origins 拿到条目实际所属目录；只允许写 Codex 当前报告的项目层，
    // 防止借道写任意路径。
    if (!projectLayers.some((layer) => layer.name.dotCodexFolder === dotCodexFolder))
      throw new ControlError(-32602, `${method}: unknown project config folder`, {
        method,
        reason: "unknown_dot_codex_folder",
      });
    folder = dotCodexFolder;
  } else {
    // 尚无 project 层（没有任何 .codex/config.toml）时回退 cwd；cwd 永远在发现路径上。
    folder = projectLayers[0]?.name.dotCodexFolder ?? join(context.cwd, ".codex");
  }
  const configFilePath = join(folder, "config.toml");
  return { configFilePath, projectRoot: dirname(folder) };
}

export async function writeProjectMcpConfig(
  context: BridgeControlContext,
  params: s.CodezMcpProjectConfigWriteParams,
): Promise<s.CodezMcpProjectConfigWriteResult> {
  const method = "mcp/projectConfigWrite";
  if (!MCP_SERVER_NAME_PATTERN.test(params.name))
    throw new ControlError(-32602, `${method}: invalid MCP server name`, {
      method,
      reason: "invalid_name",
    });
  if (params.action === "upsert") {
    const config = params.config;
    if (!config || (typeof config.command !== "string" && typeof config.url !== "string"))
      throw new ControlError(-32602, `${method}: upsert requires command or url`, {
        method,
        reason: "invalid_config",
      });
  }
  if (params.action === "set-enabled" && typeof params.enabled !== "boolean")
    throw new ControlError(-32602, `${method}: set-enabled requires enabled`, {
      method,
      reason: "invalid_enabled",
    });

  const target = await resolveProjectConfigFile(context, method, params.dotCodexFolder);
  await mkdir(dirname(target.configFilePath), { recursive: true });
  await assertNotSymlink(target.configFilePath, method);

  let table: Record<string, unknown> = {};
  try {
    const parsed = parseToml(await readFile(target.configFilePath, "utf8"));
    // 保留 mcp_servers 之外的既有项目配置（如 features/notice 等）。
    table = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const servers = { ...((table["mcp_servers"] as Record<string, unknown> | undefined) ?? {}) };

  if (params.action === "delete") {
    delete servers[params.name];
  } else if (params.action === "upsert") {
    servers[params.name] = params.config;
  } else {
    const existing = servers[params.name];
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw new ControlError(-32602, `${method}: no project MCP server named "${params.name}"`, {
        method,
        reason: "not_found",
      });
    const next = { ...(existing as Record<string, unknown>) };
    // 使能 = 删除 enabled 键恢复 Codex 默认启用；失能 = 显式 enabled=false。
    if (params.enabled) delete next["enabled"];
    else next["enabled"] = false;
    servers[params.name] = next;
  }
  table["mcp_servers"] = servers;

  // 项目 config.toml 可能提交到仓库共享，沿用 agents 角色文件的默认权限语义，
  // 不强制 0600；secret 应按 Codex 惯例走 bearer_token_env_var / env 间接引用。
  await writeFileAtomic(target.configFilePath, stringifyToml(table));
  // 直接写文件绕过了原生 config/batchWrite，必须显式 reload 让运行时重读。
  await context.rpc.request("config/mcpServer/reload", {});
  return s.codezMcpProjectConfigWriteResultSchema.parse(target);
}
