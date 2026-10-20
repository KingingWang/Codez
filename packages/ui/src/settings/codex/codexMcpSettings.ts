/**
 * Codex 桌面端 MCP 服务管理的数据层（spec: specs/codex-desktop-mcp-settings.md）。
 *
 * 事实源是 Codex 原生配置：user 层（~/.codex/config.toml）经 config/batchWrite 写，
 * project 层（.codex/config.toml）原生 RPC 禁写、经 bridge 控制面
 * mcp/projectConfigWrite 落盘并 reload。本模块只做纯数据组装与请求构造，
 * 不写文件、不直接持有状态。
 */
import {
  codexConfigResponseSchema,
  codexConfigWriteResponseSchema,
  type CodexConfigResponse,
  type CodexRequest,
} from "@codez/shared";
import { codexUserConfigTarget } from "./codexSettingsData.js";

/** 与 config/batchWrite keyPath 的 TOML 裸键口径一致；不合规名称只读展示。 */
export const CODEX_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CodexMcpScope = "user" | "project" | "builtin";

export interface CodexMcpStatusView {
  runtimeStatus: string | null;
  authStatus: string;
  toolCount: number;
  toolsError: string | null;
}

export interface CodexMcpServerEntry {
  name: string;
  scope: CodexMcpScope;
  /** 有效配置视角的启停（enabled !== false）。 */
  enabled: boolean;
  /** 所属层文件原文条目；builtin 为有效配置投影（只读）。 */
  rawConfig: Record<string, unknown>;
  /** project 条目所属 .codex 目录（多层叠放时写回该层）。 */
  dotCodexFolder?: string;
  /** 所在 project 层被禁用（项目未信任）：条目不进有效配置，仍可管理文件。 */
  layerDisabled: boolean;
  status?: CodexMcpStatusView;
  /** 名称合规且来源可写（user/project）。 */
  manageable: boolean;
}

export interface CodexMcpProjectLayerView {
  dotCodexFolder: string;
  /** 非空 = 项目未信任，Codex 不加载该层。 */
  disabledReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function layerMcpServers(layerConfig: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(layerConfig)) return {};
  const servers = layerConfig["mcp_servers"];
  if (!isRecord(servers)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) result[name] = value;
  }
  return result;
}

export function readCodexMcpProjectLayers(
  config: CodexConfigResponse | undefined,
): CodexMcpProjectLayerView[] {
  return (config?.layers ?? [])
    .filter((layer) => layer.name.type === "project" && layer.name.dotCodexFolder)
    .map((layer) => ({
      dotCodexFolder: layer.name.dotCodexFolder as string,
      ...(layer.disabledReason ? { disabledReason: layer.disabledReason } : {}),
    }));
}

/** 项目根 = dotCodexFolder 去掉结尾的 /.codex（兼容 Windows 分隔符）。 */
export function codexProjectRootFromDotFolder(dotCodexFolder: string): string {
  return dotCodexFolder.replace(/[\\/]+\.codex[\\/]*$/, "");
}

/**
 * 汇总有效配置与未信任 project 层里的全部 MCP 条目。
 * 归属判定优先 origins（叶子 keyPath 的权威来源），退化到层成员检查。
 */
export function listCodexMcpServers(
  config: CodexConfigResponse | undefined,
  statuses: ReadonlyMap<string, CodexMcpStatusView>,
): CodexMcpServerEntry[] {
  const effective = isRecord(config?.config["mcp_servers"])
    ? (config.config["mcp_servers"] as Record<string, unknown>)
    : {};
  const layers = config?.layers ?? [];
  const userLayer = layers.find(
    (layer) => layer.name.type === "user" && !layer.name.profile && layer.name.file,
  );
  const projectLayers = layers.filter((layer) => layer.name.type === "project");
  const userServers = layerMcpServers(userLayer?.config);

  const originsByName = new Map<string, { type: string; dotCodexFolder?: string }>();
  for (const [keyPath, origin] of Object.entries(config?.origins ?? {})) {
    if (!keyPath.startsWith("mcp_servers.")) continue;
    const name = keyPath.slice("mcp_servers.".length).split(".")[0];
    if (!name || originsByName.has(name)) continue;
    originsByName.set(name, {
      type: origin.name.type,
      ...(origin.name.dotCodexFolder ? { dotCodexFolder: origin.name.dotCodexFolder } : {}),
    });
  }

  const entries: CodexMcpServerEntry[] = [];
  const seen = new Set<string>();

  for (const [name, effectiveValue] of Object.entries(effective)) {
    if (!isRecord(effectiveValue)) continue;
    seen.add(name);
    const origin = originsByName.get(name);
    let scope: CodexMcpScope;
    let dotCodexFolder: string | undefined;
    if (origin?.type === "project") {
      scope = "project";
      dotCodexFolder = origin.dotCodexFolder;
    } else if (origin?.type === "user") {
      scope = "user";
    } else if (!origin) {
      // 没有 origin 信息时按层成员判定；都没有 = 内置/会话注入。
      if (userServers[name]) scope = "user";
      else if (projectLayers.some((layer) => layerMcpServers(layer.config)[name]))
        scope = "project";
      else scope = "builtin";
    } else {
      scope = "builtin";
    }
    const projectOwner =
      scope === "project"
        ? projectLayers.find((layer) =>
            dotCodexFolder
              ? layer.name.dotCodexFolder === dotCodexFolder
              : layerMcpServers(layer.config)[name],
          )
        : undefined;
    const raw =
      scope === "user"
        ? (userServers[name] ?? effectiveValue)
        : scope === "project"
          ? ((projectOwner ? layerMcpServers(projectOwner.config)[name] : undefined) ??
            effectiveValue)
          : effectiveValue;
    entries.push({
      name,
      scope,
      enabled: effectiveValue["enabled"] !== false,
      rawConfig: raw,
      ...((dotCodexFolder ?? projectOwner?.name.dotCodexFolder)
        ? { dotCodexFolder: dotCodexFolder ?? projectOwner?.name.dotCodexFolder }
        : {}),
      layerDisabled: false,
      ...(statuses.get(name) ? { status: statuses.get(name) } : {}),
      manageable: CODEX_MCP_SERVER_NAME_PATTERN.test(name) && scope !== "builtin",
    });
  }

  // 未信任 project 层的条目不进有效配置，但仍列出（layerDisabled）以便管理。
  for (const layer of projectLayers) {
    if (!layer.disabledReason) continue;
    const folder = layer.name.dotCodexFolder;
    for (const [name, raw] of Object.entries(layerMcpServers(layer.config))) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({
        name,
        scope: "project",
        enabled: raw["enabled"] !== false,
        rawConfig: raw,
        ...(folder ? { dotCodexFolder: folder } : {}),
        layerDisabled: true,
        ...(statuses.get(name) ? { status: statuses.get(name) } : {}),
        manageable: CODEX_MCP_SERVER_NAME_PATTERN.test(name),
      });
    }
  }

  // 状态列表里出现但配置缺失的条目（会话注入，或 config/read 不可用）：
  // 只读列出并保留运行时状态与发现错误，避免 discovery 错误被静默吞掉。
  for (const [name, status] of statuses) {
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({
      name,
      scope: "builtin",
      enabled: true,
      rawConfig: {},
      layerDisabled: false,
      status,
      manageable: false,
    });
  }

  const scopeOrder: Record<CodexMcpScope, number> = { project: 0, user: 1, builtin: 2 };
  return entries.sort(
    (a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// 写入请求构造与编排
// ---------------------------------------------------------------------------

type CodexConfigEdit = { keyPath: string; value: unknown; mergeStrategy: "replace" | "upsert" };

export function codexMcpUpsertEdits(
  name: string,
  config: Record<string, unknown>,
): CodexConfigEdit[] {
  return [{ keyPath: `mcp_servers.${name}`, value: config, mergeStrategy: "replace" }];
}

export function codexMcpDeleteEdits(name: string): CodexConfigEdit[] {
  return [{ keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: "replace" }];
}

export function codexMcpSetEnabledEdits(name: string, enabled: boolean): CodexConfigEdit[] {
  // 使能 = 删除 enabled 键恢复 Codex 默认启用；失能 = 显式 enabled=false。
  return [
    {
      keyPath: `mcp_servers.${name}.enabled`,
      value: enabled ? null : false,
      mergeStrategy: "replace",
    },
  ];
}

/** 信任项目根：写 user 层 projects."<root>".trust_level（实测 batchWrite 支持带引号段）。 */
export function codexProjectTrustEdits(projectRoot: string): CodexConfigEdit[] {
  return [
    {
      keyPath: `projects.${JSON.stringify(projectRoot)}.trust_level`,
      value: "trusted",
      mergeStrategy: "replace",
    },
  ];
}

interface CodexMcpRequestSender {
  request(request: CodexRequest): Promise<unknown>;
}

/** user 层写入统一入口：fresh read 取 expectedVersion → batchWrite → reload。 */
async function writeUserLayer(
  sender: CodexMcpRequestSender,
  edits: CodexConfigEdit[],
): Promise<void> {
  // expectedVersion 不能依赖可能过期的设置快照（与 CUA 清理同一纪律）。
  const fresh = codexConfigResponseSchema.parse(
    await sender.request({ method: "config/read", params: { includeLayers: true } }),
  );
  const target = codexUserConfigTarget(fresh);
  if (!target) throw new Error("No writable native Codex user configuration version");
  codexConfigWriteResponseSchema.parse(
    await sender.request({ method: "config/batchWrite", params: { ...target, edits } }),
  );
  await sender.request({ method: "config/mcpServer/reload" });
}

export async function saveCodexUserMcpServer(
  sender: CodexMcpRequestSender,
  name: string,
  config: Record<string, unknown>,
  originalName?: string,
): Promise<void> {
  const edits = originalName
    ? [...codexMcpDeleteEdits(originalName), ...codexMcpUpsertEdits(name, config)]
    : codexMcpUpsertEdits(name, config);
  await writeUserLayer(sender, edits);
}

export async function deleteCodexUserMcpServer(
  sender: CodexMcpRequestSender,
  name: string,
): Promise<void> {
  await writeUserLayer(sender, codexMcpDeleteEdits(name));
}

export async function setCodexUserMcpServerEnabled(
  sender: CodexMcpRequestSender,
  name: string,
  enabled: boolean,
): Promise<void> {
  await writeUserLayer(sender, codexMcpSetEnabledEdits(name, enabled));
}

export async function trustCodexProject(
  sender: CodexMcpRequestSender,
  projectRoot: string,
): Promise<void> {
  await writeUserLayer(sender, codexProjectTrustEdits(projectRoot));
}

// ---------------------------------------------------------------------------
// 表单 ↔ Codex 原生条目
// ---------------------------------------------------------------------------

export type CodexMcpTransport = "stdio" | "http";

export interface CodexMcpKeyValueRow {
  key: string;
  value: string;
}

export interface CodexMcpServerFormState {
  scope: "user" | "project";
  /** 编辑时锁定原名称（不支持改名以外的原名称透传）。 */
  originalName?: string;
  dotCodexFolder?: string;
  name: string;
  transport: CodexMcpTransport;
  command: string;
  /** 每行一个参数。 */
  argsText: string;
  envRows: CodexMcpKeyValueRow[];
  cwd: string;
  url: string;
  headerRows: CodexMcpKeyValueRow[];
  bearerTokenEnvVar: string;
  startupTimeoutSec: string;
  toolTimeoutSec: string;
}

export const EMPTY_CODEX_MCP_FORM: CodexMcpServerFormState = {
  scope: "user",
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envRows: [],
  cwd: "",
  url: "",
  headerRows: [],
  bearerTokenEnvVar: "",
  startupTimeoutSec: "",
  toolTimeoutSec: "",
};

function rowsToRecord(rows: CodexMcpKeyValueRow[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    record[key] = row.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function recordToRows(value: unknown): CodexMcpKeyValueRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, v]) => ({
    key,
    value: typeof v === "string" ? v : String(v),
  }));
}

function optionalTimeout(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("timeout must be a positive number");
  return parsed;
}

/** 表单 → Codex 原生 server 条目；校验失败抛错由调用方展示。 */
export function codexMcpFormToConfig(form: CodexMcpServerFormState): Record<string, unknown> {
  const name = form.name.trim();
  if (!CODEX_MCP_SERVER_NAME_PATTERN.test(name)) throw new Error("invalid server name");
  const startupTimeoutSec = optionalTimeout(form.startupTimeoutSec);
  const toolTimeoutSec = optionalTimeout(form.toolTimeoutSec);
  const timeouts = {
    ...(startupTimeoutSec !== undefined ? { startup_timeout_sec: startupTimeoutSec } : {}),
    ...(toolTimeoutSec !== undefined ? { tool_timeout_sec: toolTimeoutSec } : {}),
  };
  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (!command) throw new Error("command required");
    const args = form.argsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const env = rowsToRecord(form.envRows);
    const cwd = form.cwd.trim();
    return {
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...timeouts,
    };
  }
  const url = form.url.trim();
  if (!url) throw new Error("url required");
  const headers = rowsToRecord(form.headerRows);
  const bearerTokenEnvVar = form.bearerTokenEnvVar.trim();
  return {
    url,
    ...(headers ? { http_headers: headers } : {}),
    ...(bearerTokenEnvVar ? { bearer_token_env_var: bearerTokenEnvVar } : {}),
    ...timeouts,
  };
}

/** 所属层原始条目 → 表单。未知字段不进入表单，保存时经 JSON 模式可保留。 */
export function codexMcpConfigToForm(
  name: string,
  raw: Record<string, unknown>,
  scope: "user" | "project",
  dotCodexFolder?: string,
): CodexMcpServerFormState {
  const transport: CodexMcpTransport = typeof raw["url"] === "string" ? "http" : "stdio";
  return {
    scope,
    originalName: name,
    ...(dotCodexFolder ? { dotCodexFolder } : {}),
    name,
    transport,
    command: typeof raw["command"] === "string" ? raw["command"] : "",
    argsText: Array.isArray(raw["args"]) ? raw["args"].map((arg) => String(arg)).join("\n") : "",
    envRows: recordToRows(raw["env"]),
    cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : "",
    url: typeof raw["url"] === "string" ? raw["url"] : "",
    headerRows: recordToRows(raw["http_headers"]),
    bearerTokenEnvVar:
      typeof raw["bearer_token_env_var"] === "string" ? raw["bearer_token_env_var"] : "",
    startupTimeoutSec:
      typeof raw["startup_timeout_sec"] === "number" ? String(raw["startup_timeout_sec"]) : "",
    toolTimeoutSec:
      typeof raw["tool_timeout_sec"] === "number" ? String(raw["tool_timeout_sec"]) : "",
  };
}
