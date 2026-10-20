/**
 * ZCode 官方插件目录的契约层：CDN 目录 schema、生成的 Codex 本地市场 schema、
 * 桥侧车元数据 schema，以及共享给商店投影的目录类型。
 * 独立于物化器（official-plugin-marketplace.ts）以保持文件规模与职责单一。
 */
import { z } from "zod";

export const OFFICIAL_SOURCE_NAME = "zcode-plugins-official";
export const OFFICIAL_NATIVE_NAME = "codez-plugins-official";
export const OFFICIAL_CATALOG_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type OfficialPluginInstallation = "AVAILABLE" | "NOT_AVAILABLE";

export interface OfficialCatalogPlugin {
  name: string;
  version: string;
  policy: { installation: OfficialPluginInstallation };
  description?: string;
  displayName?: string;
  category?: string;
  /** 目录自带的展示元数据，原样透传到商店 listing。 */
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  icon?: string;
  author?: string;
  authorUrl?: string;
  /** 转译产物的可见能力警告（指令级耦合、被丢弃的组件等）。 */
  warnings: string[];
  /** 该插件的官方 HTTP MCP 需要 z.ai 账号 token（宿主进程环境注入）。 */
  requiresOfficialAuth: boolean;
  requiresPaidPlan: boolean;
  /** 含钩子：安装/更新后需要桥写入 Codex 钩子信任。 */
  hasHooks: boolean;
  unavailableReason?: string;
}

export interface OfficialCatalog {
  updatedAt?: string;
  plugins: OfficialCatalogPlugin[];
}

export interface OfficialPluginCatalogSource {
  name: string;
  plugins: Array<{
    name: string;
    version: string;
    source: {
      source: "url";
      type: "zip";
      url: string;
      sha256: string;
      path: string;
    };
    description?: string;
    description_i18n?: Record<string, string>;
    displayName?: string;
    displayName_i18n?: Record<string, string>;
    category?: string;
    icon?: string;
    author?: { name: string; url?: string };
    requiresPaidPlan?: boolean;
  }>;
}

const sourcePluginSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN, "Invalid official plugin name"),
  version: z.string().regex(VERSION_PATTERN, "Invalid official plugin version"),
  source: z.object({
    source: z.literal("url"),
    type: z.literal("zip"),
    url: z.string().url(),
    sha256: z.string().regex(SHA256_PATTERN, "Invalid official artifact SHA-256"),
    path: z.string(),
  }),
  description: z.string().trim().min(1).optional(),
  description_i18n: z.record(z.string(), z.string()).optional(),
  displayName: z.string().trim().min(1).optional(),
  displayName_i18n: z.record(z.string(), z.string()).optional(),
  category: z.string().trim().min(1).optional(),
  icon: z.string().url().optional(),
  author: z.object({ name: z.string().min(1), url: z.string().url().optional() }).optional(),
  requiresPaidPlan: z.boolean().optional(),
});

export const sourceCatalogSchema = z.object({
  name: z.string(),
  plugins: z.array(sourcePluginSchema).min(1),
});

export const generatedMarketplaceSchema = z.object({
  name: z.literal(OFFICIAL_NATIVE_NAME),
  plugins: z.array(
    z.object({
      name: z.string().regex(PLUGIN_NAME_PATTERN),
      source: z.object({
        source: z.literal("local"),
        path: z.string().regex(/^\.\/plugins\/[a-z0-9][a-z0-9._-]{0,127}\/[^/]+$/u),
      }),
      policy: z.object({ installation: z.enum(["AVAILABLE", "NOT_AVAILABLE"]) }),
      description: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
      category: z.string().min(1).optional(),
    }),
  ),
});

export const sidecarMetaSchema = z.object({
  catalogUpdatedAt: z.string(),
  plugins: z.record(
    z.string(),
    z.object({
      version: z.string(),
      installation: z.enum(["AVAILABLE", "NOT_AVAILABLE"]),
      unavailableReason: z.string().optional(),
      warnings: z.array(z.string()),
      requiresOfficialAuth: z.boolean(),
      requiresPaidPlan: z.boolean(),
      hasHooks: z.boolean(),
      displayNameI18n: z.record(z.string(), z.string()).optional(),
      descriptionI18n: z.record(z.string(), z.string()).optional(),
      icon: z.string().optional(),
      author: z.string().optional(),
      authorUrl: z.string().optional(),
    }),
  ),
});

export type SidecarMeta = z.infer<typeof sidecarMetaSchema>;
