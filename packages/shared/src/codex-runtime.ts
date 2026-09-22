import { z } from "zod";

/** Settings-only native RPC allowlist. Thread/tool/filesystem RPCs are not exposed here. */
export const codexRequestMethodSchema = z.enum([
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "model/list",
  "config/read",
  "config/value/write",
  "config/batchWrite",
  "configRequirements/read",
  "skills/list",
  "skills/config/write",
  "mcpServerStatus/list",
  "mcpServer/oauth/login",
  "config/mcpServer/reload",
  "plugin/list",
  "plugin/read",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade",
]);
export const codexRequestSchema = z
  .object({
    method: codexRequestMethodSchema,
    params: z.unknown().optional(),
  })
  .strict();
export type CodexRequest = z.infer<typeof codexRequestSchema>;

export const codexRuntimeStatusSchema = z.object({
  status: z.enum(["unavailable", "starting", "ready", "error"]),
  version: z.string().optional(),
  error: z.string().optional(),
});
export type CodexRuntimeStatus = z.infer<typeof codexRuntimeStatusSchema>;

// Typed projections of the pinned native v2 schema; unrelated response fields are stripped.
export const codexAccountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.string() }),
  z.object({ type: z.literal("amazonBedrock"), usesCodexManagedCredentials: z.boolean() }),
]);
export type CodexAccount = z.infer<typeof codexAccountSchema>;
export const codexAccountReadResponseSchema = z.object({
  account: codexAccountSchema.nullable(),
  requiresOpenaiAuth: z.boolean(),
});
export const codexLoginResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({ type: z.literal("chatgpt"), loginId: z.string(), authUrl: z.string() }),
  z.object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string(),
    verificationUrl: z.string(),
    userCode: z.string(),
  }),
  z.object({ type: z.literal("chatgptAuthTokens") }),
  z.object({ type: z.literal("amazonBedrock") }),
]);
export type CodexLoginResponse = z.infer<typeof codexLoginResponseSchema>;
export const codexCancelLoginResponseSchema = z.object({
  status: z.enum(["canceled", "notFound"]),
});

export const codexModelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() }),
  ),
});
export type CodexModel = z.infer<typeof codexModelSchema>;
export const codexModelsResponseSchema = z.object({
  data: z.array(codexModelSchema),
  nextCursor: z.string().nullable(),
});

const configSourceSchema = z.object({
  type: z.string(),
  file: z.string().optional(),
  profile: z.string().nullable().optional(),
});
const configMetadataSchema = z.object({ name: configSourceSchema, version: z.string() });
export const codexConfigResponseSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  origins: z.record(z.string(), configMetadataSchema),
  layers: z
    .array(
      configMetadataSchema.extend({
        config: z.unknown(),
        // 固定版本原生 RPC 会省略未禁用层的此字段，不能因此拒绝整个配置/模型目录。
        disabledReason: z.string().nullable().optional(),
      }),
    )
    .nullable(),
});
export type CodexConfigResponse = z.infer<typeof codexConfigResponseSchema>;
export const codexConfigRequirementsResponseSchema = z.object({
  requirements: z
    .object({
      allowedApprovalPolicies: z
        .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
        .nullable(),
      allowedSandboxModes: z.array(z.string()).nullable(),
    })
    .passthrough()
    .nullable(),
});
export const codexConfigWriteResponseSchema = z.object({
  status: z.enum(["ok", "okOverridden"]),
  version: z.string(),
  filePath: z.string(),
  overriddenMetadata: z.unknown(),
});
export const codexConfigEditSchema = z
  .object({
    keyPath: z.string().min(1),
    value: z.json(),
    mergeStrategy: z.enum(["replace", "upsert"]),
  })
  .strict();
export const codexConfigEditsSchema = z.array(codexConfigEditSchema).min(1);

export const codexSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: z.string(),
  enabled: z.boolean(),
  pluginId: z.string().nullable(),
});
export const codexSkillsResponseSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(codexSkillSchema),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});
export const codexMcpStatusResponseSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      authStatus: z.enum(["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
      runtimeStatus: z.string().nullable(),
      tools: z.record(z.string(), z.unknown()),
      toolsError: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const codexMcpOauthResponseSchema = z.object({ authorizationUrl: z.string() });
export const codexPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  enabled: z.boolean(),
  installPolicy: z.enum(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]),
  availability: z.enum(["AVAILABLE", "DISABLED_BY_ADMIN"]),
  mustShowInstallationInterstitial: z.boolean().nullable(),
});
export type CodexPlugin = z.infer<typeof codexPluginSchema>;
export const codexMarketplaceSchema = z.object({
  name: z.string(),
  path: z.string().nullable(),
  plugins: z.array(codexPluginSchema),
});
export type CodexMarketplace = z.infer<typeof codexMarketplaceSchema>;
export const codexPluginsResponseSchema = z.object({
  marketplaces: z.array(codexMarketplaceSchema),
  marketplaceLoadErrors: z.array(z.object({ marketplacePath: z.string(), message: z.string() })),
  featuredPluginIds: z.array(z.string()),
});
