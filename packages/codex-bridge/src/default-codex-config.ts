import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * 首次启动默认 Codex 配置与模型目录文件初始化（spec: specs/codex-model-provider-management.md）。
 *
 * 原因与依据：
 * 1. 新安装环境下 `$CODEX_HOME/config.toml` 与 `model_catalog_json` 模型目录文件不存在；
 *    若不配置 `model_catalog_json`，GUI「模型供应商」面板的 `catalog.path` 为 null，
 *    用户无法通过界面新增或管理目录模型。
 * 2. Codex 原生自定义供应商禁止使用保留 ID `openai`（`RESERVED_MODEL_PROVIDER_IDS`），
 *    因此默认推荐供应商 ID 使用 `openai-custom`。
 * 3. Codex 原生 `load_catalog_json` 要求目录文件至少包含一条合法的 `ModelInfo`（含完整能力字段与
 *    `base_instructions`），且 GUI 新增模型时依赖首条模型作为 `codexCatalogModelTemplate` 能力模板。
 */

export const DEFAULT_CODEX_PROVIDER_ID = "openai-custom";
export const DEFAULT_CODEX_MODEL_SLUG = "gpt-5.4";
export const DEFAULT_CODEX_CATALOG_FILENAME = "models.json";

const DEFAULT_BASE_INSTRUCTIONS =
  "You are Codex, an AI coding agent. Collaborate with the user to inspect, modify, and verify the workspace safely and accurately.";

export function resolveCodexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  return override ? override : join(homedir(), ".codex");
}

export function createRecommendedCatalogModelEntry(options?: {
  slug?: string;
  provider?: string;
  displayName?: string;
}): Record<string, unknown> {
  const slug = options?.slug?.trim() || DEFAULT_CODEX_MODEL_SLUG;
  const provider = options?.provider?.trim() || DEFAULT_CODEX_PROVIDER_ID;
  const displayName = options?.displayName?.trim() || slug;
  return {
    slug,
    provider,
    display_name: displayName,
    description: "Recommended default coding model.",
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    input_modalities: ["text", "image"],
    supports_image_detail_original: true,
    truncation_policy: {
      mode: "tokens",
      limit: 10000,
    },
    supports_parallel_tool_calls: true,
    tool_mode: null,
    use_responses_lite: true,
    include_skills_usage_instructions: true,
    auto_review_model_override: null,
    context_window: 272000,
    max_context_window: 272000,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    default_reasoning_summary: "none",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      {
        effort: "low",
        description: "Fast responses with lighter reasoning",
      },
      {
        effort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
      {
        effort: "high",
        description: "Greater reasoning depth for complex problems",
      },
      {
        effort: "xhigh",
        description: "Extra high reasoning depth for complex problems",
      },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority: 1,
    experimental_supported_tools: [],
    supports_search_tool: true,
    default_service_tier: null,
    supports_reasoning_summaries: true,
    base_instructions: DEFAULT_BASE_INSTRUCTIONS,
  };
}

export function createRecommendedCodexConfigToml(options?: {
  providerId?: string;
  modelSlug?: string;
  catalogFilename?: string;
}): string {
  const providerId = options?.providerId?.trim() || DEFAULT_CODEX_PROVIDER_ID;
  const modelSlug = options?.modelSlug?.trim() || DEFAULT_CODEX_MODEL_SLUG;
  const catalogFilename = options?.catalogFilename?.trim() || DEFAULT_CODEX_CATALOG_FILENAME;
  return [
    `model_provider = ${JSON.stringify(providerId)}`,
    `model = ${JSON.stringify(modelSlug)}`,
    `model_catalog_json = ${JSON.stringify(catalogFilename)}`,
    'model_reasoning_effort = "high"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    "",
    `[model_providers.${providerId}]`,
    'name = "OpenAI Compatible"',
    'base_url = "https://api.openai.com/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }
}

function resolveCatalogPathFromConfig(codexHome: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(codexHome, trimmed);
}

/**
 * 在拉起 `codex app-server` 前幂等补齐缺失的 `config.toml` 与模型目录文件。
 * 已有文件绝不覆盖。
 */
export async function ensureDefaultCodexConfigFiles(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  codexHome: string;
  configPath: string;
  catalogPath: string | null;
  createdConfig: boolean;
  createdCatalog: boolean;
}> {
  const codexHome = resolveCodexHomeDir(env);
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");

  if (!(await fileExists(configPath))) {
    const catalogPath = join(codexHome, DEFAULT_CODEX_CATALOG_FILENAME);
    const catalogContent = `${JSON.stringify(
      { models: [createRecommendedCatalogModelEntry()] },
      null,
      2,
    )}\n`;
    // 先落盘模型目录，再创建引用它的 config.toml，避免并发启动的 codex 读到悬空引用。
    const createdCatalog = await writeIfMissing(catalogPath, catalogContent);
    const createdConfig = await writeIfMissing(
      configPath,
      createRecommendedCodexConfigToml(),
    );
    return {
      codexHome,
      configPath,
      catalogPath,
      createdConfig,
      createdCatalog,
    };
  }

  // config.toml 已存在：不修改用户配置；若显式配置了 model_catalog_json 但目录文件缺失，则自动补齐。
  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch {
    return {
      codexHome,
      configPath,
      catalogPath: null,
      createdConfig: false,
      createdCatalog: false,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const table = parseToml(rawConfig);
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      return {
        codexHome,
        configPath,
        catalogPath: null,
        createdConfig: false,
        createdCatalog: false,
      };
    }
    parsed = table as Record<string, unknown>;
  } catch {
    // 用户手编了语法错误的 TOML 时不静默吞掉或覆写，交由后续 codex 原生报错诊断。
    return {
      codexHome,
      configPath,
      catalogPath: null,
      createdConfig: false,
      createdCatalog: false,
    };
  }

  const rawCatalogPath =
    typeof parsed["model_catalog_json"] === "string" && parsed["model_catalog_json"].trim()
      ? parsed["model_catalog_json"].trim()
      : null;
  if (!rawCatalogPath) {
    return {
      codexHome,
      configPath,
      catalogPath: null,
      createdConfig: false,
      createdCatalog: false,
    };
  }

  const catalogPath = resolveCatalogPathFromConfig(codexHome, rawCatalogPath);
  if (await fileExists(catalogPath)) {
    return {
      codexHome,
      configPath,
      catalogPath,
      createdConfig: false,
      createdCatalog: false,
    };
  }

  const provider =
    typeof parsed["model_provider"] === "string" && parsed["model_provider"].trim()
      ? parsed["model_provider"].trim()
      : DEFAULT_CODEX_PROVIDER_ID;
  const slug =
    typeof parsed["model"] === "string" && parsed["model"].trim()
      ? parsed["model"].trim()
      : DEFAULT_CODEX_MODEL_SLUG;
  const catalogContent = `${JSON.stringify(
    { models: [createRecommendedCatalogModelEntry({ slug, provider })] },
    null,
    2,
  )}\n`;
  const createdCatalog = await writeIfMissing(catalogPath, catalogContent);
  return {
    codexHome,
    configPath,
    catalogPath,
    createdConfig: false,
    createdCatalog,
  };
}
