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
  type NativeBrowserCuaMcpDescriptor,
  type NativeBrowserCuaMcpRuntimeMissingDescriptor,
} from "@codez/shared";

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
  // 原生 RPC 可能省略 nextCursor（而非返回 null）；循环按 falsy 结束，语义不变。
  parse: (value: unknown) => { data: T[]; nextCursor?: string | null },
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

export function codexNativeBrowserCuaServerValue(descriptor: NativeBrowserCuaMcpDescriptor) {
  return {
    command: descriptor.executable,
    args: [descriptor.bridgePath, "native-browser-cua-mcp"],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      {
        name: "CODEZ_NATIVE_BROWSER_CUA_ENDPOINT",
        value: descriptor.endpoint,
      },
      { name: "CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE", value: descriptor.tokenFile },
    ],
  };
}

function matchesNativeBrowserCuaServerValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((entry, index) => matchesNativeBrowserCuaServerValue(entry, expected[index]))
    );
  }
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") {
    return actual === expected;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actualKeys.every((key) =>
      matchesNativeBrowserCuaServerValue(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      ),
    )
  );
}

export function codexNativeBrowserCuaInstallRequest(
  target: NonNullable<ReturnType<typeof codexUserConfigTarget>>,
  descriptor: NativeBrowserCuaMcpDescriptor,
): CodexRequest {
  return {
    method: "config/batchWrite",
    params: {
      ...target,
      edits: [
        {
          keyPath: "mcp_servers.codez-desktop-browser-cua",
          value: codexNativeBrowserCuaServerValue(descriptor),
          mergeStrategy: "replace",
        },
      ],
    },
  };
}

export function isCodexNativeBrowserCuaConfigured(
  config: CodexConfigResponse | undefined,
  descriptor: NativeBrowserCuaMcpDescriptor | undefined,
): boolean {
  if (!descriptor) return false;
  const raw = config?.config["mcp_servers"];
  if (!raw || typeof raw !== "object") return false;
  const value = (raw as Record<string, unknown>)["codez-desktop-browser-cua"];
  return matchesNativeBrowserCuaServerValue(value, codexNativeBrowserCuaServerValue(descriptor));
}

export type CodexNativeBrowserCuaStatus =
  | "unsupported"
  | "runtime-missing"
  | "service-not-running"
  | "descriptor-unavailable"
  | "not-configured"
  | "configured";

export function classifyCodexNativeBrowserCua(input: {
  capability: string | undefined;
  remote: boolean;
  descriptor?:
    | NativeBrowserCuaMcpDescriptor
    | NativeBrowserCuaMcpRuntimeMissingDescriptor
    | undefined;
  descriptorError?: string;
  configured: boolean;
}): CodexNativeBrowserCuaStatus {
  if (input.capability !== "degraded" && input.capability !== "supported") return "unsupported";
  if (input.remote) return "unsupported";
  if (input.descriptorError) return "descriptor-unavailable";
  if (!input.descriptor) return "descriptor-unavailable";
  if (!input.descriptor.runtimeInstalled || !input.descriptor.bridgePath) return "runtime-missing";
  if (!input.descriptor.serviceRunning) return "service-not-running";
  return input.configured ? "configured" : "not-configured";
}

export async function installCodexNativeBrowserCuaMcp(
  controller: {
    request(request: CodexRequest): Promise<unknown>;
    snapshot: { config?: { data?: CodexConfigResponse } };
  },
  descriptor: NativeBrowserCuaMcpDescriptor,
): Promise<void> {
  const target = codexUserConfigTarget(controller.snapshot.config?.data);
  if (!target) throw new Error("No writable native Codex user configuration version");
  await controller.request(codexNativeBrowserCuaInstallRequest(target, descriptor));
  await controller.request({ method: "config/mcpServer/reload" });
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor) {
      if (seenCursors.has(cursor) || seenCursors.size >= 100)
        throw new Error("Invalid Codex pagination cursor");
      seenCursors.add(cursor);
    }
    const result = codexMcpStatusResponseSchema.parse(
      await controller.request({
        method: "mcpServerStatus/list",
        params: cursor ? { cursor } : {},
      }),
    );
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
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
  // subagents 由 CodexSettingsSection 的 agents 面板承载（文件型 agent roles）。
  return ["codex", "modelProvider", "skill", "subagents", "mcp", "plugin"].includes(section);
}

// 定时任务（automations）在 Codex 适配器上已支持（spec: codex-desktop-automations
// UI surfacing），不能再归入不支持分区；闲时/工作流标签页由页面内部灰度裁决。
export function isCodexUnsupportedSection(section: string): boolean {
  return ["memory", "commands", "hooks", "browser", "computerUse", "migration"].includes(section);
}
