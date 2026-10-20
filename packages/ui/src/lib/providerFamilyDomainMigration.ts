import type { IServiceAccessor } from "@codez/services";
import {
  type ProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@codez/shared";
import { logger } from "@/logger.js";

function inferProviderFamilyDomainFromSelection(
  providers: readonly { readonly providerId: string }[],
): ProviderFamilyDomain | null {
  const usableDomains = new Set<ProviderFamilyDomain>();

  for (const provider of providers) {
    const domain = resolveModelProviderFamilyIdByProviderId(provider.providerId);
    if (!domain) continue;
    usableDomains.add(domain);
  }

  if (usableDomains.size !== 1) {
    return null;
  }
  return [...usableDomains][0] ?? null;
}

export async function ensureProviderFamilyDomainMigration(
  services: Pick<IServiceAccessor, "settingService" | "oauthService" | "modelSelectionService">,
  isCurrent: () => boolean,
): Promise<void> {
  const settings = await services.settingService.get();
  // 原生 Codex 接管期间旧设置读取可能才返回；后续 OAuth/Registry 与设置写入均不再属于本 Host。
  if (!isCurrent()) return;
  if (settings.providerFamilyDomain || settings.providerFamilyDomainMigrated) {
    return;
  }

  const activeProvider = await services.oauthService.getActiveProvider();
  if (!isCurrent()) return;
  let inferredDomain = resolveProviderFamilyDomainFromOAuthProvider(activeProvider);
  let selectableProviders: readonly { readonly providerId: string }[] | null = null;

  if (!inferredDomain) {
    try {
      selectableProviders = (await services.modelSelectionService.getView()).providers;
      if (!isCurrent()) return;
      inferredDomain = inferProviderFamilyDomainFromSelection(selectableProviders);
    } catch (error) {
      logger.warn("[providerFamilyDomainMigration] 读取模型选择视图失败", {
        error,
      });
    }
  }

  if (!inferredDomain && selectableProviders?.length === 0) {
    // 启动早期 OAuth active provider 和 Registry 可能都还没恢复。
    // 此时如果把“空结果”标记为已迁移，会让后续草稿预热在 selectedKey 为空时吃到旧 Start Plan 偏好。
    logger.info("[providerFamilyDomainMigration] provider family domain 迁移等待模型选择视图恢复");
    return;
  }

  if (!isCurrent()) return;
  await services.settingService.update({
    ...(inferredDomain ? { providerFamilyDomain: inferredDomain } : {}),
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });

  // 写入发出后也可能切换 Host；迟到完成不能把新 Codex Host 记为旧设置迁移完成。
  if (!isCurrent()) return;
  logger.info("[providerFamilyDomainMigration] provider family domain 迁移完成", {
    inferredDomain,
  });
}
