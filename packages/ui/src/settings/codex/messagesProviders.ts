// 「模型供应商」面板的文案（specs/codex-model-provider-management.md）；
// 从 messages.ts 拆出以控制单文件行数，键集必须与 zhProviders 对齐。
export const enProviders = {
  providers: "Providers",
  providersHelp:
    "OpenAI-compatible providers from config.toml model_providers. Changes hot-reload every loaded thread immediately. API keys can be written to config.toml in plaintext or kept on this device and injected as a temporary environment variable; values are never displayed here.",
  providerAdd: "Add provider",
  providerEdit: "Edit",
  providerDelete: "Delete",
  providerSetDefault: "Set as default",
  providerDefaultBadge: "Default",
  providerDeviceKeyBadge: "Device key",
  providerId: "Provider id",
  providerIdHelp:
    "Letters, digits, _ and - only. Becomes the model_providers table key and cannot be changed later.",
  providerIdLocked:
    "The id is the config table key; create a new provider to rename.",
  providerIdInvalid: "Provider id may only contain letters, digits, _ and -.",
  providerIdTaken: "A provider with this id already exists.",
  providerBaseUrlRequired: "Base URL is required.",
  providerBaseUrlInvalid:
    "Base URL must be an absolute http:// or https:// URL with a host.",
  providerName: "Display name",
  providerBaseUrl: "Base URL",
  providerWireApi: "Wire API",
  providerToken: "API key",
  providerTokenHelp:
    "Stored in plaintext as experimental_bearer_token. Leave empty to keep the current value.",
  providerTokenRuntimeEnvHelp:
    "Stored only in this device's Codez credential store; config.toml keeps an env_key reference and the value is injected when the agent starts. Leave empty to keep the current value.",
  providerTokenConfigured: "Configured (value hidden)",
  providerTokenRequired: "Enter the API key.",
  providerKeyNotInstalled:
    "The key is not saved on this device yet; enter it and save before using this provider.",
  providerTokenClear: "Clear the stored key",
  providerKeySource: "Key storage",
  providerKeySourceConfigFile: "In config file",
  providerKeySourceRuntimeEnv: "On this device (temporary env)",
  providerKeySourceRuntimeEnvWarning:
    "The value enters the agent process environment on the target machine. Anyone sharing the same OS account there may read it while connected; this is not per-person isolation.",
  providerKeySourceUnsupported:
    "This environment does not support device-local key storage.",
  providerKeySourceConflictsOpenaiAuth:
    "requires_openai_auth makes Codex ignore env_key; device-local storage is unavailable.",
  providerKeySourceConflictsAuthCommand:
    "This provider uses an [auth] command table, which cannot be combined with env_key.",
  providerExternalEnvKeyNotice:
    "This provider currently references an external environment variable via env_key. Saving with either storage choice replaces that reference.",
  providerRequiresOpenaiAuth: "Requires OpenAI auth (auth.json)",
  providerEmpty: "No providers configured.",
  providerDeleteDefaultBlocked:
    "The default provider cannot be deleted; set another provider as default first.",
  providerDeleteModelsBlocked:
    "Catalog models still reference this provider; delete or move those models first.",
  providerCatalogUnavailable:
    "Provider deletion is unavailable until catalog models have been loaded successfully.",
  providerModelCount: "models",
  providerModelCountUnknown: "model references unknown",
  providerSave: "Save provider",
  providerCancel: "Cancel",
  providerModels: "Catalog models",
  providerModelsHelp:
    "Models from the model_catalog_json file, grouped by provider. Edits apply to new turns immediately; the composer model picker refreshes after a runtime restart.",
  providerModelsEmpty: "No catalog models.",
  modelAdd: "Add model",
  modelSlug: "Model slug",
  modelSlugEditHelp:
    "Changing the slug replaces this catalog entry in place; update config.model separately if the default model should follow.",
  modelSlugHelp:
    "Unique model id sent to the provider API; cannot be changed after creation.",
  modelProvider: "Provider",
  modelDisplayName: "Display name",
  modelDescription: "Description",
  modelHidden: "Hidden from the model picker",
  modelVisible: "Show in the model picker",
  modelAdvancedJson: "Advanced JSON",
  modelAdvancedJsonHelp:
    "The full catalog entry. Identity fields (slug, provider, display name, description, visibility) are overwritten by the fields above on save.",
  modelInvalid: "Invalid model entry: check slug/provider and the JSON syntax.",
  modelNoCatalog:
    "model_catalog_json is not configured, so catalog models cannot be managed. Configure it in config.toml first.",
  modelCatalogStale:
    "Catalog saved; new turns can use the changes now. Restart the runtime to refresh the composer model picker.",
  modelRestartRuntime: "Restart runtime now",
  modelConfirmRestart: "Confirm restart",
  modelRestartRuntimeConfirm:
    "Restarting interrupts running tasks in this workspace. Continue?",
  modelDeleteLastBlocked:
    "Keep at least one catalog model; add a replacement before deleting this one.",
  modelDeleteDefaultWarning:
    "This model is the configured default (config.model); new threads fall back to the provider-preferred model.",
  modelSave: "Save model",
};

export const zhProviders: Record<keyof typeof enProviders, string> = {
  providers: "模型供应商",
  providersHelp:
    "config.toml model_providers 中的 OpenAI 兼容供应商。修改立即热刷新所有已加载线程。API Key 可明文写入 config.toml，也可只保存在本机、以临时环境变量注入；此处不回显。",
  providerAdd: "添加供应商",
  providerEdit: "编辑",
  providerDelete: "删除",
  providerSetDefault: "设为默认",
  providerDefaultBadge: "默认",
  providerDeviceKeyBadge: "本机 Key",
  providerId: "供应商 id",
  providerIdHelp:
    "仅限字母、数字、_ 和 -。将成为 model_providers 表键，创建后不可修改。",
  providerIdLocked: "id 即配置表键，不可修改；改名请新建供应商。",
  providerIdInvalid: "供应商 id 只能包含字母、数字、_ 和 -。",
  providerIdTaken: "已存在同名 id 的供应商。",
  providerBaseUrlRequired: "Base URL 必填。",
  providerBaseUrlInvalid:
    "Base URL 必须是带主机名的绝对 http:// 或 https:// 地址。",
  providerName: "显示名称",
  providerBaseUrl: "Base URL",
  providerWireApi: "Wire API",
  providerToken: "API Key",
  providerTokenHelp:
    "以明文存储为 experimental_bearer_token。留空表示保持当前值不变。",
  providerTokenRuntimeEnvHelp:
    "仅保存在本机 Codez 凭据中；config.toml 只留 env_key 引用，Agent 启动时注入。留空表示保持当前值不变。",
  providerTokenConfigured: "已配置（不回显）",
  providerTokenRequired: "请输入 API Key。",
  providerKeyNotInstalled: "本机尚未保存该 Key；输入并保存后才能使用该供应商。",
  providerTokenClear: "清除已存储的 Key",
  providerKeySource: "Key 存储方式",
  providerKeySourceConfigFile: "写入配置文件",
  providerKeySourceRuntimeEnv: "本机保存（临时环境变量）",
  providerKeySourceRuntimeEnvWarning:
    "Key 会进入目标机器的 Agent 进程环境。共享同一远程账户的人在连接期间仍可能读到；这不是按人隔离。",
  providerKeySourceUnsupported: "当前环境不支持本机保存（如 Server 远程）。",
  providerKeySourceConflictsOpenaiAuth:
    "requires_openai_auth 开启时 Codex 会忽略 env_key，无法使用本机保存。",
  providerKeySourceConflictsAuthCommand:
    "该供应商使用 [auth] 命令鉴权，与临时环境变量互斥。",
  providerExternalEnvKeyNotice:
    "该供应商当前通过 env_key 引用外部环境变量；选择任一存储方式保存后将替换该引用。",
  providerRequiresOpenaiAuth: "需要 OpenAI 鉴权（auth.json）",
  providerEmpty: "尚未配置供应商。",
  providerDeleteDefaultBlocked:
    "默认供应商不能删除；请先把其他供应商设为默认。",
  providerDeleteModelsBlocked:
    "仍有目录模型引用该供应商；请先删除或迁移这些模型。",
  providerCatalogUnavailable: "目录模型尚未成功读取，暂时无法删除供应商。",
  providerModelCount: "个模型",
  providerModelCountUnknown: "模型引用数未知",
  providerSave: "保存供应商",
  providerCancel: "取消",
  providerModels: "目录模型",
  providerModelsHelp:
    "model_catalog_json 文件中的模型，按供应商分组。修改立即对新对话生效；composer 模型下拉在运行时重启后刷新。",
  providerModelsEmpty: "目录中暂无模型。",
  modelAdd: "添加模型",
  modelSlug: "模型 slug",
  modelSlugEditHelp:
    "修改 slug 会原地替换该目录条目；如需默认模型跟随，请单独更新 config.model。",
  modelSlugHelp: "发送给供应商 API 的唯一模型 id；创建后不可修改。",
  modelProvider: "所属供应商",
  modelDisplayName: "显示名称",
  modelDescription: "描述",
  modelHidden: "在模型下拉中隐藏",
  modelVisible: "在模型下拉中显示",
  modelAdvancedJson: "高级 JSON",
  modelAdvancedJsonHelp:
    "完整的目录条目。保存时身份字段（slug、provider、显示名称、描述、可见性）以上方表单为准。",
  modelInvalid: "模型条目无效：请检查 slug/provider 与 JSON 语法。",
  modelNoCatalog:
    "未配置 model_catalog_json，无法管理目录模型。请先在 config.toml 中配置。",
  modelCatalogStale:
    "目录已保存，新对话立即可用。重启运行时以刷新 composer 模型下拉。",
  modelRestartRuntime: "立即重启运行时",
  modelConfirmRestart: "确认重启",
  modelRestartRuntimeConfirm: "重启将中断该工作区正在运行的任务，继续？",
  modelDeleteLastBlocked:
    "目录至少需要保留一个模型；请先添加替代模型再删除此模型。",
  modelDeleteDefaultWarning:
    "该模型是配置的默认模型（config.model）；新会话将回退到供应商偏好模型。",
  modelSave: "保存模型",
};
