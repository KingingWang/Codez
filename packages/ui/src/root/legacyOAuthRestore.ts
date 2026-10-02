import type { OAuthProviderId } from "@codez/shared";

interface LegacyOAuthRestore {
  hasRestoredUser: boolean;
  isCurrent: () => boolean;
  readActiveProvider: () => Promise<OAuthProviderId | null>;
  refreshRestoredProviderFamily: (provider: OAuthProviderId | null) => Promise<unknown>;
  refreshProviderState: () => Promise<void>;
}

/** 旧账号恢复只在原 Host effect 有效时推进；不能把迟到回包刷新到原生 Codex。 */
export async function resumeRootLegacyOAuthSession({
  hasRestoredUser,
  isCurrent,
  readActiveProvider,
  refreshRestoredProviderFamily,
  refreshProviderState,
}: LegacyOAuthRestore): Promise<void> {
  if (hasRestoredUser) {
    const activeProvider = await readActiveProvider();
    if (!isCurrent()) return;
    await refreshRestoredProviderFamily(activeProvider);
  }
  // family 更新可能等待网络/Host IO；恢复期间切换 Host 后旧 Provider 不能再被唤醒。
  if (!isCurrent()) return;
  await refreshProviderState();
}
