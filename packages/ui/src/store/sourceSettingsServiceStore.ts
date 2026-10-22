import { useSyncExternalStore } from "react";
import type { IServiceAccessor } from "@codez/services";

interface SourceSettingsServicesEntry {
  attachmentId: string;
  services: IServiceAccessor;
  dispose: () => void;
}

interface RegisterSourceSettingsServicesParams extends SourceSettingsServicesEntry {
  sourceServerId: string;
}

const servicesBySourceServerId = new Map<string, SourceSettingsServicesEntry>();
const listeners = new Set<() => void>();
const registrationWaiters = new Map<string, Set<() => void>>();
const REGISTRATION_WAIT_TIMEOUT_MS = 500;

function emit(): void {
  for (const listener of listeners) listener();
}

export function registerSourceSettingsServices(
  params: RegisterSourceSettingsServicesParams,
): () => void {
  const { sourceServerId } = params;
  const entry: SourceSettingsServicesEntry = {
    attachmentId: params.attachmentId,
    services: params.services,
    dispose: params.dispose,
  };
  const previous = servicesBySourceServerId.get(sourceServerId);
  servicesBySourceServerId.set(sourceServerId, entry);
  previous?.dispose();
  const waiters = registrationWaiters.get(sourceServerId);
  if (waiters) {
    registrationWaiters.delete(sourceServerId);
    for (const resolve of waiters) resolve();
  }
  emit();
  return () => {
    // Bug 原因：旧 attachment 的 close 可能晚于新一代注册；只按 Source 删除会误删当前服务。
    if (servicesBySourceServerId.get(sourceServerId) !== entry) return;
    servicesBySourceServerId.delete(sourceServerId);
    entry.dispose();
    emit();
  };
}

export function getSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return sourceServerId ? servicesBySourceServerId.get(sourceServerId)?.services : undefined;
}

export function useSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSourceSettingsServices(sourceServerId),
    () => undefined,
  );
}

// 同一 Source 的配置面板共享一次 attachment admission，不复制物理连接或业务状态。
const attachmentRequests = new Map<string, Promise<void>>();
export function ensureSourceSettingsServices(
  sourceServerId: string,
  request: (id: string) => Promise<{ attachmentId: string }>,
): Promise<void> {
  if (getSourceSettingsServices(sourceServerId)) return Promise.resolve();
  const pending = attachmentRequests.get(sourceServerId);
  if (pending) return pending;
  const result = request(sourceServerId)
    .then(async () => {
      if (getSourceSettingsServices(sourceServerId)) return;
      // Bugfix: Main 进程在 IPC invoke 中同步 postMessage 发送 MessagePort 后立即返回，
      // Renderer 收到 window message 并调用 registerSourceSettingsServices 可能晚一拍。
      // 等待端口实际注册完成再 resolve，避免调用方紧接着 getSourceSettingsServices 拿到 undefined。
      await new Promise<void>((resolve) => {
        let waiterSet = registrationWaiters.get(sourceServerId);
        if (!waiterSet) {
          waiterSet = new Set();
          registrationWaiters.set(sourceServerId, waiterSet);
        }
        const finish = () => {
          clearTimeout(timer);
          waiterSet?.delete(finish);
          if (waiterSet?.size === 0) registrationWaiters.delete(sourceServerId);
          resolve();
        };
        const timer = setTimeout(finish, REGISTRATION_WAIT_TIMEOUT_MS);
        waiterSet.add(finish);
      });
    })
    .finally(() => {
      if (attachmentRequests.get(sourceServerId) === result)
        attachmentRequests.delete(sourceServerId);
    });
  attachmentRequests.set(sourceServerId, result);
  return result;
}
