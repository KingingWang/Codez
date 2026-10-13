import {
  isCodexNativeProviderKeyEnvName,
  type CodexConfigResponse,
  type CodezCatalogModelEntry,
} from "@codez/shared";

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
  /** config.toml 中的 env_key 引用（可能是 App 托管或用户手工外部变量）。 */
  envKey?: string;
  /** 用户手编的 [auth] 命令鉴权；与 env_key/明文互斥，GUI 不托管。 */
  hasAuthCommand: boolean;
  isDefault: boolean;
  /** 调用方 join 的 catalog 引用数，用于删除保护提示。 */
  modelCount: number;
}

export type CodexProviderKeySource = "config-file" | "runtime-env";

/** App 托管的环境变量引用；手工外部 env_key 返回 false（不显示为「本机保存」）。 */
export function isCodexManagedEnvKey(envKey: string | undefined): boolean {
  return envKey !== undefined && isCodexNativeProviderKeyEnvName(envKey);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
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
    if (provider)
      countByProvider.set(provider, (countByProvider.get(provider) ?? 0) + 1);
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
        hasBearerToken:
          optionalString(entry.experimental_bearer_token) !== undefined,
        envKey: optionalString(entry.env_key),
        hasAuthCommand: typeof entry.auth === "object" && entry.auth !== null,
        isDefault: id === defaultId,
        modelCount: countByProvider.get(id) ?? 0,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id),
    );
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
  /** Key 来源：写入配置文件（旧语义）或本机保存+临时环境变量（spec: codex-provider-runtime-env-key）。 */
  keySource: CodexProviderKeySource;
  /** 仅输入新值时写入；与 clearBearerToken 互斥。 */
  bearerToken: string;
  clearBearerToken: boolean;
  /** 编辑态记录的原有 env_key 引用；用于保存时决定是否移除该键。 */
  initialEnvKey?: string;
}

export function codexProviderFormFrom(
  view?: CodexProviderView,
): CodexProviderForm {
  return {
    id: view?.id ?? "",
    name: view?.name ?? "",
    baseUrl: view?.baseUrl ?? "",
    wireApi: view?.wireApi ?? "chat",
    requiresOpenaiAuth: view?.requiresOpenaiAuth ?? false,
    keySource: isCodexManagedEnvKey(view?.envKey)
      ? "runtime-env"
      : "config-file",
    bearerToken: "",
    clearBearerToken: false,
    ...(view?.envKey ? { initialEnvKey: view.envKey } : {}),
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

/** runtime-env 模式必须携带 Host 生成的 envName；调用方应先完成 prepareKeySource。 */
export interface CodexProviderKeyResolution {
  envName?: string;
}

function providerTableValue(
  form: CodexProviderForm,
  keyResolution?: CodexProviderKeyResolution,
): Record<string, unknown> {
  if (form.keySource === "runtime-env") {
    if (!keyResolution?.envName)
      throw new Error("Missing managed env name for provider key");
    return {
      name: form.name.trim() || form.id,
      base_url: form.baseUrl.trim(),
      wire_api: form.wireApi,
      requires_openai_auth: form.requiresOpenaiAuth,
      env_key: keyResolution.envName,
    };
  }
  return {
    name: form.name.trim() || form.id,
    base_url: form.baseUrl.trim(),
    wire_api: form.wireApi,
    requires_openai_auth: form.requiresOpenaiAuth,
    ...(form.bearerToken
      ? { experimental_bearer_token: form.bearerToken }
      : {}),
  };
}

/**
 * base_url 与 codex 原生请求期 `url::Url::parse` 同口径：必须是带 host 的绝对
 * http/https URL。GUI 提前拒绝，避免把运行时才会失败的坏配置写进 config.toml。
 */
export function isCodexProviderBaseUrlValid(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  // hostname 检查是主防线（个别引擎对 "http://" 不抛错而给出空 host），
  // try/catch 只负责语法非法的输入；两者共同对齐原生 Url::parse 的失败面。
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname.length > 0
  );
}

/** 校验表单；返回错误文案键，合法返回 null。 */
export function codexProviderFormError(
  form: CodexProviderForm,
  creating: boolean,
  existingIds: readonly string[],
):
  | "providerIdInvalid"
  | "providerIdTaken"
  | "providerBaseUrlRequired"
  | "providerBaseUrlInvalid"
  | "providerTokenRequired"
  | null {
  if (creating) {
    if (!CODEX_PROVIDER_ID_PATTERN.test(form.id.trim()))
      return "providerIdInvalid";
    if (existingIds.includes(form.id.trim())) return "providerIdTaken";
    // 新建选本机保存时必须显式输入 Key；不允许静默复用同名供应商的历史凭据。
    if (form.keySource === "runtime-env" && !form.bearerToken.trim())
      return "providerTokenRequired";
  }
  if (!form.baseUrl.trim()) return "providerBaseUrlRequired";
  if (!isCodexProviderBaseUrlValid(form.baseUrl))
    return "providerBaseUrlInvalid";
  return null;
}

/** 新建 = 整表 replace（新键无未知字段需要保留）。 */
export function codexProviderCreateEdits(
  form: CodexProviderForm,
  keyResolution?: CodexProviderKeyResolution,
): CodexConfigEdit[] {
  // 新建表单上 clearBearerToken 无语义（token 未输入即不存在），防御性忽略。
  return [
    edit(
      `model_providers.${form.id.trim()}`,
      providerTableValue(form, keyResolution),
    ),
  ];
}

/** 更新 = 逐字段 replace/delete，保留用户手编的未知 key（chat_stream/query_params 等）。 */
export function codexProviderUpdateEdits(
  form: CodexProviderForm,
  keyResolution?: CodexProviderKeyResolution,
): CodexConfigEdit[] {
  const id = form.id.trim();
  const base = `model_providers.${id}`;
  const edits = [
    edit(`${base}.name`, form.name.trim() || id),
    edit(`${base}.base_url`, form.baseUrl.trim()),
    edit(`${base}.wire_api`, form.wireApi),
    edit(`${base}.requires_openai_auth`, form.requiresOpenaiAuth),
  ];
  if (form.keySource === "runtime-env") {
    if (!keyResolution?.envName)
      throw new Error("Missing managed env name for provider key");
    // 本机保存：config.toml 只留 env_key 引用，明文键必须移除。
    edits.push(edit(`${base}.env_key`, keyResolution.envName));
    edits.push(edit(`${base}.experimental_bearer_token`, null));
  } else {
    // 显式选择配置文件来源时移除原有 env_key 引用（含用户手工外部变量）。
    if (form.initialEnvKey) edits.push(edit(`${base}.env_key`, null));
    if (form.clearBearerToken)
      edits.push(edit(`${base}.experimental_bearer_token`, null));
    else if (form.bearerToken)
      edits.push(edit(`${base}.experimental_bearer_token`, form.bearerToken));
  }
  return edits;
}

/** 删除阻断原因，对应文案 key；null 表示允许删除。 */
export type CodexProviderDeleteBlock =
  | "providerCatalogUnavailable"
  | "providerDeleteDefaultBlocked"
  | "providerDeleteModelsBlocked";

/**
 * 删除保护的单一判定来源：目录未成功读取时引用数未知，必须先 fail-closed。
 * 按钮禁用与写入前判定共用本函数，删除不变量不只存在于渲染期 prop。
 */
export function codexProviderDeleteBlock(
  view: Pick<CodexProviderView, "isDefault" | "modelCount">,
  catalogReady: boolean,
): CodexProviderDeleteBlock | null {
  if (!catalogReady) return "providerCatalogUnavailable";
  if (view.isDefault) return "providerDeleteDefaultBlocked";
  if (view.modelCount > 0) return "providerDeleteModelsBlocked";
  return null;
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

export function codexCatalogModelView(
  entry: CodezCatalogModelEntry,
): CodexCatalogModelView {
  return {
    slug: entry.slug,
    provider: optionalString(entry.provider),
    displayName: optionalString(entry.display_name) ?? entry.slug,
    description: optionalString(entry.description),
    hidden: entry.visibility === "hidden",
  };
}

export interface CodexCatalogModelGroup {
  key: string;
  label: string;
  entries: CodexCatalogModelView[];
}

/** 目录模型按 provider 分组：provider 顺序与供应商列表一致，未匹配组排在最后。 */
export function codexCatalogModelGroups(
  models: readonly CodezCatalogModelEntry[],
  providers: readonly CodexProviderView[],
): CodexCatalogModelGroup[] {
  const groups = new Map<
    string,
    { label: string; entries: CodexCatalogModelView[] }
  >();
  for (const entry of models) {
    const view = codexCatalogModelView(entry);
    const key = view.provider ?? "";
    const label =
      providers.find((provider) => provider.id === key)?.name ??
      (key || entry.slug);
    const bucket = groups.get(key);
    if (bucket) bucket.entries.push(view);
    else groups.set(key, { label, entries: [view] });
  }
  const ordered = [
    ...providers.map((provider) => provider.id),
    ...[...groups.keys()].filter((key) => !providers.some((p) => p.id === key)),
  ];
  return ordered
    .filter((key) => groups.has(key))
    .map((key) => ({ key, ...groups.get(key)! }));
}

/** 新增模型的能力模板：同 provider 首条模型剥离身份字段；无模板时给最小骨架。 */
export function codexCatalogModelTemplate(
  models: readonly CodezCatalogModelEntry[],
  providerId: string,
): Record<string, unknown> {
  const source =
    models.find((entry) => optionalString(entry.provider) === providerId) ??
    models[0];
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
  /** 编辑态为原始 slug（定位旧条目）；slug 字段允许编辑时原位改名。 */
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
      optionalString((base as Record<string, unknown>).display_name) ??
      (entry ? entry.slug : ""),
    description:
      optionalString((base as Record<string, unknown>).description) ?? "",
    hidden: (base as Record<string, unknown>).visibility === "hidden",
    rawJson: JSON.stringify(base, null, 2),
  };
}

/**
 * 表单 → catalog 条目：rawJson 提供能力字段，简单字段覆盖身份字段。
 * rawJson 非法或缺 slug/provider 时返回 null，由 UI 提示。
 */
export function codexModelEntryFromForm(
  form: CodexModelForm,
): CodezCatalogModelEntry | null {
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

/** 编辑态必须携带原始 slug；创建态不发送该字段，保持新增/upsert 旧语义。 */
export function codexCatalogModelWriteParams<
  T extends { workspacePath: string; workspaceIdentity?: string },
>(
  form: CodexModelForm,
  workspace: T,
): T & { model: CodezCatalogModelEntry; originalSlug?: string } {
  const entry = codexModelEntryFromForm(form);
  if (!entry) throw new Error("Invalid catalog model form");
  return {
    ...workspace,
    model: entry,
    ...(form.originalSlug ? { originalSlug: form.originalSlug } : {}),
  };
}
