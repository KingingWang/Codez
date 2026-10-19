import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buildRewardsUrl, resolveRewardsOrigin, CODEZ_ENV } from "@codez/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useCodezStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { RewardsWebview } from "@/rewards/RewardsWebview.js";
import { logger } from "@/logger.js";

const RewardsContext = createContext<(() => Promise<void>) | null>(null);
export const useOpenRewards = () => useContext(RewardsContext);
export function RewardsProvider({
  children,
  desktop,
}: {
  children: ReactNode;
  desktop: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const platform = usePlatform();
  const { locale } = useCodezIntl();
  const theme = useCodezStore((s) => s.theme);
  const user = useCodezStore((s) => s.user);
  const loginAttempt = useCodezStore((s) => s.loginEntryAttempt);
  const requestLogin = useCodezStore((s) => s.requestLoginEntry);
  // 登录后营销实例会重建；续接意图由窗口级 Provider 持有，不能挂在旧 controller 上。
  const pendingLogin = useRef<number | null>(null);
  const openPage = useCallback(async () => {
    if (desktop) setOpened(true);
    else
      await platform.openExternal(
        buildRewardsUrl(
          resolveRewardsOrigin({ env: CODEZ_ENV }),
          locale,
          resolveTheme(theme) === "dark" ? "zai-dark" : "zai-light",
        ),
      );
  }, [desktop, platform, locale, theme]);
  const open = useCallback(async () => {
    if (!user) {
      if (pendingLogin.current === null)
        pendingLogin.current = requestLogin(undefined, "app-login");
      return;
    }
    pendingLogin.current = null;
    await openPage();
  }, [user, requestLogin, openPage]);
  useEffect(() => {
    const pending = pendingLogin.current;
    if (pending === null || !loginAttempt) return;
    if (
      loginAttempt.id !== pending ||
      loginAttempt.status === "cancelled" ||
      loginAttempt.status === "failed"
    ) {
      pendingLogin.current = null;
      return;
    }
    if (loginAttempt.status === "succeeded" && user) {
      pendingLogin.current = null;
      void openPage().catch((error) => logger.warn("[rewards] 登录后打开失败", { error }));
    }
  }, [loginAttempt, user, openPage]);
  return (
    <RewardsContext.Provider value={open}>
      {children}
      {opened && <RewardsWebview onClose={() => setOpened(false)} />}
    </RewardsContext.Provider>
  );
}
