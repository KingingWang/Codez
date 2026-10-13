import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Provisioning 中允许跨 Environment 传输的凭据类别。 */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** 仅供校验 schema v1 旧信封；新 Source 不导出、新 Target 不应用这些历史 Key。 */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/** Personal Config 的 Envelope；具体字段由 @codez/provider 在目标 Environment 再校验。 */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    // v3 允许 Personal Config 中引用临时 Key；旧 Target 必须在任何写入前拒绝。
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.schemaVersion !== 1 &&
      value.credentials.some((entry) => entry.scope !== "oauth-session")
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Provisioning v${value.schemaVersion} only accepts OAuth credentials`,
        path: ["credentials"],
      });
    }
  });

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

/** 临时值只经可信连接安装到目标 Host 内存，绝不属于 Provisioning 磁盘信封。 */
export const providerRuntimeApiKeySchema = z
  .object({
    name: z.string().regex(/^CODEZ_MODEL_API_KEY_[A-F0-9]{6,64}$/),
    value: nonEmptyString,
  })
  .strict();
export const providerRuntimeApiKeyInstallSchema = z
  .object({
    configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    keys: z.array(providerRuntimeApiKeySchema).max(256),
  })
  .strict();
export type ProviderRuntimeApiKey = z.infer<typeof providerRuntimeApiKeySchema>;
export type ProviderRuntimeApiKeyInstall = z.infer<typeof providerRuntimeApiKeyInstallSchema>;

/** 跨进程只透传固定阶段码，不能把远端自由文本作为可公开诊断信息。 */
export const providerProvisioningErrorCodeSchema = z.enum([
  "source-read-failed",
  "target-call-failed",
  "target-write-failed",
  "target-refresh-failed",
  "target-commit-failed",
  "target-apply-failed",
  "capability-unavailable",
  "session-unavailable",
  "host-execution-failed",
]);
export type ProviderProvisioningErrorCode = z.infer<typeof providerProvisioningErrorCodeSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;
