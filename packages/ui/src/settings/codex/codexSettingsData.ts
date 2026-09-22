import {
  codexAccountReadResponseSchema,
  codexConfigResponseSchema,
  codexConfigRequirementsResponseSchema,
  codexModelsResponseSchema,
  codexSkillsResponseSchema,
  codexMcpStatusResponseSchema,
  codexPluginsResponseSchema,
  type CodexConfigResponse,
  type CodexMarketplace,
  type CodexModel,
  type CodexPlugin,
  type CodexRequest,
} from "@zcode/shared";

export const codexReaders = {
  account: codexAccountReadResponseSchema,
  config: codexConfigResponseSchema,
  requirements: codexConfigRequirementsResponseSchema,
  models: codexModelsResponseSchema,
  skills: codexSkillsResponseSchema,
  mcp: codexMcpStatusResponseSchema,
  plugins: codexPluginsResponseSchema,
};
export type CodexResource = keyof typeof codexReaders;
export type CodexResourceData = {
  [K in CodexResource]: ReturnType<(typeof codexReaders)[K]["parse"]>;
};
export type CodexResourceState<K extends CodexResource> = {
  data?: CodexResourceData[K];
  error?: string;
};
export type CodexSnapshot = { [K in CodexResource]?: CodexResourceState<K> };
export type CodexRequestSender = (request: CodexRequest) => Promise<unknown>;

export function codexReadRequest(resource: CodexResource, cwd: string): CodexRequest {
  switch (resource) {
    case "account":
      return { method: "account/read", params: { refreshToken: false } };
    case "config":
      return { method: "config/read", params: { cwd, includeLayers: true } };
    case "requirements":
      return { method: "configRequirements/read" };
    case "models":
      return { method: "model/list", params: { includeHidden: false } };
    case "skills":
      return { method: "skills/list", params: { cwds: [cwd], forceReload: true } };
    case "mcp":
      return { method: "mcpServerStatus/list", params: {} };
    case "plugins":
      return { method: "plugin/list", params: { cwds: [cwd] } };
  }
}

export async function readCodexResource<K extends CodexResource>(
  resource: K,
  cwd: string,
  send: CodexRequestSender,
): Promise<CodexResourceData[K]> {
  const request = codexReadRequest(resource, cwd);
  if (resource === "models") {
    return (await readCodexPages(
      codexModelsResponseSchema.parse,
      request,
      send,
    )) as CodexResourceData[K];
  }
  if (resource === "mcp") {
    return (await readCodexPages(
      codexMcpStatusResponseSchema.parse,
      request,
      send,
    )) as CodexResourceData[K];
  }
  return codexReaders[resource].parse(await send(request)) as CodexResourceData[K];
}

async function readCodexPages<T>(
  parse: (value: unknown) => { data: T[]; nextCursor: string | null },
  request: CodexRequest,
  send: CodexRequestSender,
) {
  // 原生列表有游标；只取首页会把模型或 MCP 状态错误地呈现为完整列表。
  const page = parse(await send(request));
  const seen = new Set<string>();
  while (page.nextCursor) {
    const cursor = page.nextCursor;
    if (seen.has(cursor) || seen.size >= 100) throw new Error("Invalid Codex pagination cursor");
    seen.add(cursor);
    const next = parse(
      await send({
        ...request,
        params: { ...(request.params as object), cursor },
      }),
    );
    page.data.push(...next.data);
    page.nextCursor = next.nextCursor;
  }
  return page;
}

export function codexUserConfigTarget(config: CodexConfigResponse | undefined) {
  const layer = config?.layers?.find(
    (entry) =>
      entry.name.type === "user" && !entry.name.profile && !entry.disabledReason && entry.name.file,
  );
  return layer ? { filePath: layer.name.file!, expectedVersion: layer.version } : null;
}

export function codexModelEdits(model: CodexModel, effort: string) {
  if (!model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)) {
    throw new Error("Unsupported reasoning effort for this model");
  }
  return [
    { keyPath: "model", value: model.model, mergeStrategy: "replace" as const },
    { keyPath: "model_reasoning_effort", value: effort, mergeStrategy: "replace" as const },
  ];
}

export function codexPluginInstallRequest(
  marketplace: CodexMarketplace,
  plugin: CodexPlugin,
): CodexRequest {
  if (
    plugin.availability !== "AVAILABLE" ||
    plugin.installPolicy === "NOT_AVAILABLE" ||
    plugin.mustShowInstallationInterstitial
  ) {
    throw new Error("Plugin requires native consent or is unavailable under current policy");
  }
  return {
    method: "plugin/install",
    params: {
      pluginName: plugin.name,
      ...(marketplace.path
        ? { marketplacePath: marketplace.path }
        : { remoteMarketplaceName: marketplace.name }),
    },
  };
}

export function codexAuthorizationUrl(value: string): string {
  const url = new URL(value);
  // 不允许原生响应中的任意协议进入桌面 openExternal（例如 file:/javascript:）。
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Unsafe authorization URL");
  return url.href;
}

export function isCodexSettingsSection(section: string): boolean {
  return ["codex", "modelProvider", "skill", "mcp", "plugin"].includes(section);
}

export function isCodexUnsupportedSection(section: string): boolean {
  return [
    "memory",
    "subagents",
    "commands",
    "hooks",
    "browser",
    "computerUse",
    "automations",
    "migration",
  ].includes(section);
}
