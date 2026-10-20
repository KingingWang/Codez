import { isApiKeyAccess, type ProviderId } from "@codez/provider";
import type { ICredentialService } from "../credential/credential.js";
import type { IProviderSettingsService } from "./providerFacadeServices.js";
import {
  providerRuntimeApiKeyCredentialKey,
  providerRuntimeApiKeyEnvName,
} from "./providerProvisioningSource.js";

type Settings = Pick<IProviderSettingsService, "getView" | "savePersonalProviderOverlay">;
type Credentials = Pick<ICredentialService, "load" | "save" | "delete">;

export async function saveProviderApiKeySource(
  deps: { providerSettings: Settings; credentials: Credentials },
  input: { providerId: ProviderId; mode: "config-file" | "runtime-env"; apiKey?: string },
): ReturnType<IProviderSettingsService["getView"]> {
  const provider = (await deps.providerSettings.getView()).providers.find(
    (entry) => entry.providerId === input.providerId,
  );
  if (!provider || !isApiKeyAccess(provider.effectiveConfig.access)) {
    throw new Error("只有手工 API Key Provider 可以切换 Key 来源");
  }
  const personal = provider.personalConfig ?? {};
  const credentialKey = providerRuntimeApiKeyCredentialKey(input.providerId);
  const previousCredential = await deps.credentials.load(credentialKey);
  const effectiveKey = provider.effectiveConfig.access.apiKey?.trim();
  const nextKey = input.apiKey?.trim() || previousCredential?.trim() || effectiveKey;
  if (!nextKey) throw new Error("请先输入 API Key");

  const nextAccess = {
    ...(isApiKeyAccess(personal.access) ? personal.access : {}),
    type: provider.effectiveConfig.access.type,
    ...(input.mode === "runtime-env"
      ? { apiKey: null, apiKeyEnv: providerRuntimeApiKeyEnvName(input.providerId) }
      : { apiKey: nextKey, apiKeyEnv: null }),
  };
  // 凭据与 Personal Config 分属两个正式 Store：先备份旧值，再写凭据，配置失败时恢复。
  // 不能把缺失/失败当成空 Key 同步到远端，也不能在配置成功前宣告模式已切换。
  if (input.mode === "runtime-env") await deps.credentials.save(credentialKey, nextKey);
  else if (previousCredential !== null) await deps.credentials.delete(credentialKey);
  try {
    return await deps.providerSettings.savePersonalProviderOverlay(input.providerId, {
      ...personal,
      access: nextAccess,
    });
  } catch (error) {
    try {
      if (previousCredential === null) await deps.credentials.delete(credentialKey);
      else await deps.credentials.save(credentialKey, previousCredential);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Provider Key 来源保存与恢复均失败");
    }
    throw error;
  }
}
