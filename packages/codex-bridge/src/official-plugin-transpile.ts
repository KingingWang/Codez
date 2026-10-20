/**
 * ZCode 官方插件 → Codex 兼容包的确定性转译器。
 *
 * 设计原则（spec: codex-zcode-plugin-compatibility「Compatibility pipeline」）：
 * - 数据驱动规则，不按插件名硬编码；新插件/新版本走同一条管线。
 * - 变量烘焙分两类：插件根路径烘焙为绝对物化路径（Codex 不展开 legacy MCP 配置里的
 *   `${CLAUDE_PLUGIN_ROOT}`，且安装后读取的是缓存副本）；钩子命令保留 `${CLAUDE_PLUGIN_ROOT}`
 *   由 Codex 发现期展开；项目目录（`${ZCODE_PROJECT_DIR}`）不可烘焙，删除 cwd 让
 *   服务器继承 per-workspace 的 app-server cwd。
 * - 任何不认识的组件/变量/传输类型都只降级该组件并产生可见 warning；
 *   仅当插件再无可用组件时才判 NOT_AVAILABLE，绝不静默报成功。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adaptHooks } from "./official-plugin-hooks.js";
import { scanZcodeRuntimeCoupling } from "./official-plugin-scan.js";
import { isObject, VARIABLE_PATTERN } from "./official-plugin-utils.js";
import type { JsonObject } from "./official-plugin-utils.js";

export interface OfficialPluginTranspileOptions {
  /** 解压后的插件目录（暂存位置）。 */
  pluginDir: string;
  /** 物化后的最终绝对路径（用于烘焙进 MCP 配置）。 */
  bakedPluginRoot: string;
  /** `${ZCODE_BASE_URL}` 的解析结果（Codez 端点 origin）。 */
  zcodeBaseUrl: string;
  expectedName: string;
  expectedVersion: string;
}

export interface OfficialPluginTranspileResult {
  installation: "AVAILABLE" | "NOT_AVAILABLE";
  unavailableReason?: string;
  warnings: string[];
  requiresOfficialAuth: boolean;
  requiresPaidPlan: boolean;
  hasHooks: boolean;
  components: {
    skills: boolean;
    commands: boolean;
    hooks: boolean;
    mcpServers: string[];
  };
}

/** Codex 无法执行的 manifest 组件字段 → 整个插件不可用。 */
const UNSUPPORTED_MANIFEST_FIELDS = ["channels", "lspServers", "outputStyles", "settings"] as const;

const VARIABLE_PROBE = /\$\{[^}]+\}/u;
interface UserConfigDefault {
  default?: unknown;
}

async function readJsonFile(path: string): Promise<JsonObject | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function transpileOfficialPlugin(
  options: OfficialPluginTranspileOptions,
): Promise<OfficialPluginTranspileResult> {
  const warnings = new Set<string>();
  let requiresOfficialAuth = false;
  let requiresPaidPlan = false;

  // ── 1. Manifest ────────────────────────────────────────────────────────────
  const claudeManifestPath = join(options.pluginDir, ".claude-plugin", "plugin.json");
  const zcodeManifest = await readJsonFile(join(options.pluginDir, ".zcode-plugin", "plugin.json"));
  let manifest = await readJsonFile(claudeManifestPath);
  if (!manifest) {
    if (!zcodeManifest) {
      return unavailable("no manifest compatible with Codex (.claude-plugin/plugin.json missing)");
    }
    // 仅复制 Codex 认识的字段；其余（auth/requiresPaidPlan/userConfig…）由规则处理或忽略。
    manifest = {
      name: zcodeManifest.name,
      version: zcodeManifest.version,
      ...(typeof zcodeManifest.description === "string"
        ? { description: zcodeManifest.description }
        : {}),
      ...(Array.isArray(zcodeManifest.keywords) ? { keywords: zcodeManifest.keywords } : {}),
      ...(typeof zcodeManifest.displayName === "string"
        ? { interface: { displayName: zcodeManifest.displayName } }
        : {}),
      ...(zcodeManifest.skills !== undefined ? { skills: zcodeManifest.skills } : {}),
      ...(zcodeManifest.commands !== undefined ? { commands: zcodeManifest.commands } : {}),
      ...(zcodeManifest.hooks !== undefined ? { hooks: zcodeManifest.hooks } : {}),
      ...(zcodeManifest.mcpServers !== undefined ? { mcpServers: zcodeManifest.mcpServers } : {}),
    };
  }
  if (manifest.name !== options.expectedName || manifest.version !== options.expectedVersion) {
    return unavailable("plugin manifest name/version does not match the published catalog entry");
  }
  if (zcodeManifest?.requiresPaidPlan === true || manifest.requiresPaidPlan === true) {
    requiresPaidPlan = true;
  }

  for (const field of UNSUPPORTED_MANIFEST_FIELDS) {
    if (manifest[field] !== undefined) {
      return unavailable(`manifest component \`${field}\` is not supported by Codex`);
    }
  }

  const userConfigDefaults = collectUserConfigDefaults(manifest.userConfig);
  // userConfig 是 ZCode 交互式配置；Codex 不认识，烘焙默认值后从 manifest 移除以免误导。
  delete manifest.userConfig;

  // ── 变量烘焙（MCP 配置用绝对路径；钩子命令保留 Codex 可展开变量） ──────────
  const bakeValue = (value: string): string | null => {
    let failed = false;
    const baked = value.replace(VARIABLE_PATTERN, (_, name: string) => {
      if (name === "ZCODE_PLUGIN_ROOT" || name === "CLAUDE_PLUGIN_ROOT") {
        return options.bakedPluginRoot;
      }
      if (name === "ZCODE_BASE_URL") return options.zcodeBaseUrl;
      if (name.startsWith("user_config.")) {
        const key = name.slice("user_config.".length);
        const fallback = userConfigDefaults.get(key);
        if (fallback !== undefined) return fallback;
        failed = true;
        return "";
      }
      failed = true;
      return "";
    });
    return failed ? null : baked;
  };

  // manifest 路径字段必须带 ./ 前缀，否则 Codex 静默忽略。
  normalizeManifestPaths(manifest, warnings);

  // ── 2. MCP servers ─────────────────────────────────────────────────────────
  const mcpServerNames: string[] = [];
  const mcpFile = await readJsonFile(join(options.pluginDir, ".mcp.json"));
  const manifestMcp = isObject(manifest.mcpServers) ? manifest.mcpServers : null;
  let mcpDroppedAll = false;
  for (const container of [
    mcpFile && isObject(mcpFile.mcpServers) ? mcpFile.mcpServers : null,
    manifestMcp,
  ]) {
    if (!container) continue;
    const { kept, droppedAll } = adaptMcpServers(container, bakeValue, warnings, (auth) => {
      if (auth) requiresOfficialAuth = true;
    });
    mcpServerNames.push(...kept);
    if (droppedAll) mcpDroppedAll = true;
  }
  // 先回写再判定可用性：即使插件整体降级，物化目录也保持自洽。
  if (mcpFile) {
    await writeFile(
      join(options.pluginDir, ".mcp.json"),
      `${JSON.stringify(mcpFile, null, 2)}\n`,
      "utf8",
    );
  }
  if (manifestMcp) manifest.mcpServers = manifestMcp;
  if (mcpDroppedAll) {
    return unavailable("declared MCP servers cannot be adapted to Codex transports/auth");
  }

  // ── 3. Hooks ───────────────────────────────────────────────────────────────
  let hasHooks = false;
  const hooksPath = join(options.pluginDir, "hooks", "hooks.json");
  const hooksFile = await readJsonFile(hooksPath);
  if (hooksFile && isObject(hooksFile.hooks)) {
    hasHooks = adaptHooks(hooksFile.hooks, warnings);
    await writeFile(hooksPath, `${JSON.stringify(hooksFile, null, 2)}\n`, "utf8");
  }
  if (isObject(manifest.hooks)) {
    hasHooks = adaptHooks(manifest.hooks, warnings) || hasHooks;
  }

  // ── 4. 内容扫描（指令级 ZCode 运行时耦合 → 可见 warning，不阻塞安装） ──────
  for (const capability of await scanZcodeRuntimeCoupling(options.pluginDir)) {
    warnings.add(`Some features rely on ${capability}, which Codex does not provide`);
  }

  // ── 5. 可用性总判 ──────────────────────────────────────────────────────────
  const hasSkills = await pathExists(join(options.pluginDir, "skills"));
  const hasCommands =
    (await pathExists(join(options.pluginDir, "commands"))) || manifest.commands !== undefined;
  if (!hasSkills && !hasCommands && !hasHooks && mcpServerNames.length === 0) {
    return unavailable("no component (skills/commands/hooks/MCP) survives Codex adaptation");
  }

  await mkdir(join(options.pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(claudeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    installation: "AVAILABLE",
    warnings: [...warnings],
    requiresOfficialAuth,
    requiresPaidPlan,
    hasHooks,
    components: {
      skills: hasSkills,
      commands: hasCommands,
      hooks: hasHooks,
      mcpServers: mcpServerNames,
    },
  };

  function unavailable(reason: string): OfficialPluginTranspileResult {
    return {
      installation: "NOT_AVAILABLE",
      unavailableReason: reason,
      warnings: [...warnings],
      requiresOfficialAuth,
      requiresPaidPlan,
      hasHooks: false,
      components: { skills: false, commands: false, hooks: false, mcpServers: [] },
    };
  }
}

function collectUserConfigDefaults(userConfig: unknown): Map<string, string> {
  const defaults = new Map<string, string>();
  if (!isObject(userConfig)) return defaults;
  for (const [key, value] of Object.entries(userConfig)) {
    if (!isObject(value)) continue;
    const fallback = (value as UserConfigDefault).default;
    if (
      typeof fallback === "string" ||
      typeof fallback === "number" ||
      typeof fallback === "boolean"
    ) {
      defaults.set(key, String(fallback));
    }
  }
  return defaults;
}

function normalizeManifestPaths(manifest: JsonObject, warnings: Set<string>): void {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.startsWith("./") || value.startsWith(".codex-plugin/")) return value;
      return `./${value}`;
    }
    if (Array.isArray(value)) return value.map(normalize);
    return value;
  };
  for (const field of ["skills", "commands"] as const) {
    if (manifest[field] !== undefined) {
      manifest[field] = normalize(manifest[field]);
    }
  }
  if (typeof manifest.hooks === "string" || Array.isArray(manifest.hooks)) {
    manifest.hooks = normalize(manifest.hooks);
  }
  if (typeof manifest.mcpServers === "string" || Array.isArray(manifest.mcpServers)) {
    manifest.mcpServers = normalize(manifest.mcpServers);
  }
  void warnings;
}

/**
 * 适配一个 mcpServers 容器（原地修改）。返回保留的 server 名与是否「原本有却全被丢弃」。
 */
function adaptMcpServers(
  container: JsonObject,
  bakeValue: (value: string) => string | null,
  warnings: Set<string>,
  markOfficialAuth: (needed: boolean) => void,
): { kept: string[]; droppedAll: boolean } {
  const kept: string[] = [];
  let declared = 0;
  for (const [name, serverValue] of Object.entries(container)) {
    if (!isObject(serverValue)) {
      delete container[name];
      continue;
    }
    declared += 1;
    const server = serverValue;
    const transport =
      typeof server.type === "string" ? server.type : server.command ? "stdio" : "http";
    if (transport === "sse") {
      warnings.add(`MCP server \`${name}\` uses legacy SSE transport, unsupported by Codex`);
      delete container[name];
      continue;
    }
    // ZCode 专有 auth 对象 → Codex bearer_token_env_var；token 由宿主进程环境注入。
    if (isObject(server.auth)) {
      if (server.auth.type === "zcode_official" && transport !== "stdio") {
        delete server.auth;
        server.bearer_token_env_var = "CODEZ_ZAI_OFFICIAL_MCP_TOKEN";
        markOfficialAuth(true);
      } else {
        warnings.add(`MCP server \`${name}\` uses an auth scheme Codex cannot provide`);
        delete container[name];
        continue;
      }
    }
    // cwd 指向项目目录 → 删除，让服务器继承 per-workspace 的 app-server cwd。
    if (typeof server.cwd === "string") {
      const cwd = server.cwd.trim();
      if (cwd === "${ZCODE_PROJECT_DIR}" || cwd === "${CLAUDE_PROJECT_DIR}") {
        delete server.cwd;
      } else if (VARIABLE_PROBE.test(cwd)) {
        warnings.add(`MCP server \`${name}\` has a cwd Codex cannot resolve`);
        delete container[name];
        continue;
      }
    }
    if (
      (transport === "stdio" && typeof server.command !== "string") ||
      (transport !== "stdio" && typeof server.url !== "string")
    ) {
      warnings.add(
        `MCP server \`${name}\` is missing its ${transport === "stdio" ? "command" : "url"}`,
      );
      delete container[name];
      continue;
    }
    // 递归烘焙剩余字符串值里的变量。
    if (!bakeServerStrings(server, bakeValue)) {
      warnings.add(`MCP server \`${name}\` uses variables without declared defaults`);
      delete container[name];
      continue;
    }
    kept.push(name);
  }
  return { kept, droppedAll: declared > 0 && kept.length === 0 };
}

function bakeServerStrings(value: unknown, bakeValue: (v: string) => string | null): boolean {
  if (typeof value === "string") return bakeValue(value) !== null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") {
        const baked = bakeValue(item);
        if (baked === null) return false;
        value[index] = baked;
      } else if (!bakeServerStrings(item, bakeValue)) {
        return false;
      }
    }
    return true;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") {
        const baked = bakeValue(item);
        if (baked === null) return false;
        value[key] = baked;
      } else if (!bakeServerStrings(item, bakeValue)) {
        return false;
      }
    }
  }
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
