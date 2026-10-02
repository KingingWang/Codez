import type { ISettingService } from "@codez/services";
import {
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
} from "@codez/shared";

export function resolveLogoutProviderFamilyDomain(params: {
  currentDomain: ProviderFamilyDomain | null | undefined;
}): ProviderFamilyDomain | null {
  void params;
  return null;
}

export async function setProviderFamilyDomain(
  settingService: Pick<ISettingService, "get" | "update">,
  domain: ProviderFamilyDomain,
  isCurrent?: () => boolean,
): Promise<void> {
  const currentSettings = await settingService.get();
  // 交互登录跨 Host 切换时，旧设置读取晚到不能继续写入新 Codex 的启动环境。
  if (isCurrent?.() === false) return;
  await settingService.update({
    providerFamilyDomain: domain,
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    // WelcomeScreen OAuth 登录表示用户选择的是同 family 的 Coding Plan/OAuth 模式。
    // 只写 providerFamilyDomain 会保留之前 API Key 入口写入的 apiKey mode，导致登录成功后仍停在 API Key。
    providerFamilyConnectionSelections: buildOAuthProviderFamilySelections(
      domain,
      currentSettings.providerFamilyConnectionSelections,
    ),
  });
}

function buildOAuthProviderFamilySelections(
  domain: ProviderFamilyDomain,
  currentSelections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): ProviderFamilyConnectionSelectionSettings {
  return {
    ...currentSelections,
    [domain]: { kind: "individual-coding-plan" },
  };
}
