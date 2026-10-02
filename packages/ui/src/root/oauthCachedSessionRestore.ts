import type { OAuthCachedSessionRestoreResult, UserInfo } from "@codez/shared";
import type { AlertDialogRequest } from "@/store/alertDialogStore.js";

export async function applyCachedOAuthSessionRestoreResult(params: {
  result: OAuthCachedSessionRestoreResult;
  setUser: (user: UserInfo | null) => void;
  requestAlert: (request: AlertDialogRequest) => Promise<boolean>;
  onReauthenticationRequired: () => void;
  copy: AlertDialogRequest;
  isCurrent?: () => boolean;
}): Promise<boolean> {
  if (params.result.status === "authenticated") {
    params.setUser(params.result.userInfo);
    return true;
  }

  if (params.result.status === "reauthentication-required") {
    // 认证事实已经失效，不能等用户确认弹窗后才清 UI 登录态。
    params.setUser(null);
    await params.requestAlert(params.copy);
    // 旧账号提示可能在 Codex 接管后才结束；不能在新 Host 上继续执行重认证。
    if (params.isCurrent?.() === false) return false;
    params.onReauthenticationRequired();
  }

  return false;
}
