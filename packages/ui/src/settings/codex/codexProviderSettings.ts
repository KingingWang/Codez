import type { CodexConfigResponse, CodezCatalogModelEntry } from "@codez/shared";

/**
 * Codex 模型供应商与目录模型的设置视图（spec: specs/codex-model-provider-management.md）。
 * 供应商事实源 = config.toml 的 model_providers 表（config/batchWrite 写）；
 * 模型事实源 = model_catalog_json 目录文件（bridge catalog/* 写）。
 */

export type CodexProviderWireApi = "chat" | "responses";

export interface CodexProviderView {
  id: string;
  name: string;
  baseUrl?: string;
  wireApi: CodexProviderWireApi;
  requiresOpenaiAuth: boolean;
  /** 只呈现「已配置」状态；config/read 返回的明文绝不进入视图。 */
  hasBearerToken: boolean;
  isDefault: boolean;
  /** 调用方 join 的 catalog 引用数，用于删除保护提示。 */
  modelCount: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function codexProvidersView(
  config: CodexConfigResponse | undefined,
  catalogModels: readonly CodezCatalogModelEntry[],
): CodexProviderView[] {
  const root = (config?.config ?? {}) as Record<string, unknown>;
  const defaultId = optionalString(root.model_provider);
  const table =
    typeof root.model_providers === "object" && root.model_providers !== null
      ? (root.model_providers as Record<string, unknown>)
      : {};
  const countByProvider = new Map<string, number>();
  for (const model of catalogModels) {
    const provider = optionalString(model.provider);
    if (provider) countByProvider.set(provider, (countByProvider.get(provider) ?? 0) + 1);
  }
  return Object.entries(table)
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]): CodexProviderView => {
      const entry = value as Record<string, unknown>;
      return {
        id,
        name: optionalString(entry.name) ?? id,
        baseUrl: optionalString(entry.base_url),
        wireApi: entry.wire_api === "responses" ? "responses" : "chat",
        requiresOpenaiAuth: entry.requires_openai_auth === true,
        // RedactedString 序列化为 string；只取存在性。
        hasBearerToken: optionalString(entry.experimental_bearer_token) !== undefined,
        isDefault: id === defaultId,
        modelCount: countByProvider.get(id) ?? 0,
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

/** config.toml 中显式配置、但目录里不存在的默认模型 id（删除模型的警告判断用）。 */
export function codexConfiguredDefaultModel(
  config: CodexConfigResponse | undefined,
): string | null {
  const root = (config?.config ?? {}) as Record<string, unknown>;
  return optionalString(root.model) ?? null;
}

// ---- 供应商表单 ----

export interface CodexProviderForm {
  id: string;
  name: string;
  baseUrl: string;
  wireApi: CodexProviderWireApi;
  requiresOpenaiAuth: boolean;
  /** 仅输入新值时写入；与 clearBearerToken 互斥。 */
  bearerToken: string;
  clearBearerToken: boolean;
}

export function codexProviderFormFrom(view?: CodexProviderView): CodexProviderForm {
  return {
    id: view?.id ?? "",
    name: view?.name ?? "",
    baseUrl: view?.baseUrl ?? "",
    wireApi: view?.wireApi ?? "chat",
    requiresOpenaiAuth: view?.requiresOpenaiAuth ?? false,
    bearerToken: "",
    clearBearerToken: false,
  };
}

/** config/batchWrite keyPath 按 `.` 分段；TOML 裸键同口径。 */
export const CODEX_PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CodexConfigEdit = {
  keyPath: string;
  value: unknown;
  mergeStrategy: "replace";
};

function edit(keyPath: string, value: unknown): CodexConfigEdit {
  return { keyPath, value, mergeStrategy: "replace" };
}

function providerTableValue(form: CodexProviderForm): Record<string, unknown> {
  return {
    name: form.name.trim() || form.id,
    base_url: form.baseUrl.trim(),
    wire_api: form.wireApi,
    requires_openai_auth: form.requiresOpenaiAuth,
    ...(form.bearerToken ? { experimental_bearer_token: form.bearerToken } : {}),
  };
}

/** 校验表单；返回错误文案键，合法返回 null。 */
export function codexProviderFormError(
  form: CodexProviderForm,
  creating: boolean,
  existingIds: readonly string[],
): "providerIdInvalid" | "providerIdTaken" | "providerBaseUrlRequired" | null {
  if (creating) {
    if (!CODEX_PROVIDER_ID_PATTERN.test(form.id.trim())) return "providerIdInvalid";
    if (existingIds.includes(form.id.trim())) return "providerIdTaken";
  }
  if (!form.baseUrl.trim()) return "providerBaseUrlRequired";
  return null;
}

/** 新建 = 整表 replace（新键无未知字段需要保留）。 */
export function codexProviderCreateEdits(form: CodexProviderForm): CodexConfigEdit[] {
  // 新建表单上 clearBearerToken 无语义（token 未输入即不存在），防御性忽略。
  return [edit(`model_providers.${form.id.trim()}`, providerTableValue(form))];
}

/** 更新 = 逐字段 replace/delete，保留用户手编的未知 key（chat_stream/query_params 等）。 */
export function codexProviderUpdateEdits(form: CodexProviderForm): CodexConfigEdit[] {
  const id = form.id.trim();
  const base = `model_providers.${id}`;
  const edits = [
    edit(`${base}.name`, form.name.trim() || id),
    edit(`${base}.base_url`, form.baseUrl.trim()),
    edit(`${base}.wire_api`, form.wireApi),
    edit(`${base}.requires_openai_auth`, form.requiresOpenaiAuth),
  ];
  if (form.clearBearerToken) edits.push(edit(`${base}.experimental_bearer_token`, null));
  else if (form.bearerToken)
    edits.push(edit(`${base}.experimental_bearer_token`, form.bearerToken));
  return edits;
}

export function codexProviderDeleteEdits(id: string): CodexConfigEdit[] {
  return [edit(`model_providers.${id}`, null)];
}

export function codexProviderSetDefaultEdits(id: string): CodexConfigEdit[] {
  return [edit("model_provider", id)];
}

// ---- 目录模型表单 ----

export interface CodexCatalogModelView {
  slug: string;
  provider?: string;
  displayName: string;
  description?: string;
  hidden: boolean;
}

export function codexCatalogModelView(entry: CodezCatalogModelEntry): CodexCatalogModelView {
  return {
    slug: entry.slug,
    provider: optionalString(entry.provider),
    displayName: optionalString(entry.display_name) ?? entry.slug,
    description: optionalString(entry.description),
    hidden: entry.visibility === "hidden",
  };
}

/** 新增模型的能力模板：同 provider 首条模型剥离身份字段；无模板时给最小骨架。 */
export function codexCatalogModelTemplate(
  models: readonly CodezCatalogModelEntry[],
  providerId: string,
): Record<string, unknown> {
  const source = models.find((entry) => optionalString(entry.provider) === providerId) ?? models[0];
  if (!source) return { provider: providerId, visibility: "list" };
  const {
    slug: _slug,
    display_name: _name,
    description: _desc,
    availability_nux: _nux,
    ...rest
  } = source;
  return { ...rest, provider: providerId };
}

export interface CodexModelForm {
  /** 编辑态为原始 slug（定位用）；slug 字段允许改（= 另存新条目后删旧条，UI 层组合）。 */
  originalSlug?: string;
  slug: string;
  provider: string;
  displayName: string;
  description: string;
  hidden: boolean;
  /** 高级 JSON 草稿：初始为条目完整 JSON；保存时解析并以简单字段覆盖身份字段。 */
  rawJson: string;
}

export function codexModelFormFrom(
  entry: CodezCatalogModelEntry | undefined,
  template: Record<string, unknown>,
): CodexModelForm {
  const base = entry ?? template;
  return {
    ...(entry ? { originalSlug: entry.slug } : {}),
    slug: entry?.slug ?? "",
    provider: optionalString(base.provider) ?? "",
    displayName:
      optionalString((base as Record<string, unknown>).display_name) ?? (entry ? entry.slug : ""),
    description: optionalString((base as Record<string, unknown>).description) ?? "",
    hidden: (base as Record<string, unknown>).visibility === "hidden",
    rawJson: JSON.stringify(base, null, 2),
  };
}

/**
 * 表单 → catalog 条目：rawJson 提供能力字段，简单字段覆盖身份字段。
 * rawJson 非法或缺 slug/provider 时返回 null，由 UI 提示。
 */
export function codexModelEntryFromForm(form: CodexModelForm): CodezCatalogModelEntry | null {
  const slug = form.slug.trim();
  const provider = form.provider.trim();
  if (!slug || !provider) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(form.rawJson);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry: Record<string, unknown> = {
    ...(raw as Record<string, unknown>),
    slug,
    provider,
    visibility: form.hidden ? "hidden" : "list",
  };
  if (form.displayName.trim()) entry.display_name = form.displayName.trim();
  else delete entry.display_name;
  if (form.description.trim()) entry.description = form.description.trim();
  else delete entry.description;
  return entry as CodezCatalogModelEntry;
}
