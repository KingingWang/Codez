import { useEffect, useRef } from "react";
import type {
  WebRemoteControlAuthPlatform,
  WebRemoteControlAuthEvents,
} from "@/web-remote-control/contract.js";
import { logger } from "@/logger.js";

/**
 * 初始恢复同步一次投影；运行中的认证变更只消费 OAuth owner 的凭据完成事件。
 *
 * resolveInitialAuthUserId：原生 Codex 启动模式故意不把旧 OAuth 会话恢复成应用账号，
 * root user 在启动后恒为 null；但模块契约规定 OAuth 服务是认证唯一事实源，
 * Web 远控的初始投影必须改为静默读取缓存会话，否则每次重启都会把已登录的远控
 * 误投影成 signed-out，Main 随即把窗口置为 auth-required，表现为“重启后又要扫码登录”。
 */
export function useWebRemoteControlAuthSync(
  platform: WebRemoteControlAuthPlatform,
  oauth: WebRemoteControlAuthEvents,
  userId: string | undefined,
  restoring: boolean,
  resolveInitialAuthUserId?: () => Promise<string | undefined>,
): void {
  const initialStateSynced = useRef(false);
  useEffect(() => {
    initialStateSynced.current = false;
    if (!platform.notifyWebRemoteControlAuthStateChanged) return;
    const subscription = oauth.onDidChangeSession((state) => {
      // 实时凭据事实优先于迟到的初始 UI 投影；无需在 renderer 保存第二份认证状态。
      initialStateSynced.current = true;
      platform.notifyWebRemoteControlAuthStateChanged?.({ state });
    });
    return () => subscription.dispose();
  }, [platform, oauth]);

  useEffect(() => {
    if (restoring || initialStateSynced.current) return;
    initialStateSynced.current = true;
    if (resolveInitialAuthUserId) {
      let disposed = false;
      void resolveInitialAuthUserId()
        .catch((error: unknown) => {
          // 读取缓存会话失败按未登录投影；Main 收到投影后仍会重读凭据兜底。
          logger.warn("[WebRemoteControlAuthSync] 静默读取缓存 OAuth 会话失败", { error });
          return undefined;
        })
        .then((resolvedUserId) => {
          if (disposed) return;
          platform.notifyWebRemoteControlAuthStateChanged?.({
            state: resolvedUserId ? "signed-in" : "signed-out",
          });
        });
      return () => {
        disposed = true;
      };
    }
    platform.notifyWebRemoteControlAuthStateChanged?.({
      state: userId ? "signed-in" : "signed-out",
    });
    return undefined;
  }, [platform, oauth, userId, restoring, resolveInitialAuthUserId]);
}
