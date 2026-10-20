import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import {
  isCodexManagedEnvKey,
  type CodexProviderView,
} from "./codexProviderSettings.js";

/**
 * 探测当前 workspace 的 Host 是否提供「本机临时 Key」服务
 * （spec: codex-provider-runtime-env-key）。旧 Host / Server remote 未注册该
 * channel 时只读探测会失败；失败即隐藏来源选项，退回配置文件语义。
 */
export function useCodexProviderKeySupport(
  services: IServiceAccessor,
  enabled: boolean,
  scopeKey: string | undefined,
): boolean {
  const [supported, setSupported] = useState(false);
  const keyService = services.codexNativeProviderKeyService;
  useEffect(() => {
    let cancelled = false;
    setSupported(false);
    if (!keyService || !enabled || !scopeKey) return;
    keyService
      .getKeyState({ providerId: "__capability_probe__" })
      .then(() => {
        if (!cancelled) setSupported(true);
      })
      .catch(() => {
        if (!cancelled) setSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyService, enabled, scopeKey]);
  return supported;
}

/**
 * 编辑 App 托管供应商时的本机凭据存在性提示。只读探测失败按「未配置」处理，
 * 让用户重新输入并保存；真正的 fail-closed 判定在 Host/bridge。
 */
export function useCodexManagedKeyState(
  keyService: IServiceAccessor["codexNativeProviderKeyService"],
  supported: boolean,
): {
  managedKeyConfigured: boolean | undefined;
  probeProvider: (view: Pick<CodexProviderView, "id" | "envKey">) => void;
  reset: () => void;
} {
  const [managedKeyConfigured, setManagedKeyConfigured] = useState<
    boolean | undefined
  >(undefined);
  const reset = useCallback(() => setManagedKeyConfigured(undefined), []);
  const probeProvider = useCallback(
    (view: Pick<CodexProviderView, "id" | "envKey">) => {
      setManagedKeyConfigured(undefined);
      if (!isCodexManagedEnvKey(view.envKey) || !keyService || !supported)
        return;
      keyService
        .getKeyState({ providerId: view.id })
        .then((state) => setManagedKeyConfigured(state.configured))
        .catch(() => setManagedKeyConfigured(false));
    },
    [keyService, supported],
  );
  return { managedKeyConfigured, probeProvider, reset };
}
