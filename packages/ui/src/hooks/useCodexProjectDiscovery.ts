import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@codez/shared";
import { useOptionalPlatform } from "./usePlatform.js";
import { useOptionalServices } from "./useServices.js";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import {
  ensureSourceSettingsServices,
  getSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { logger } from "@/logger.js";

interface WorkspaceTabActivation {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface CodexProjectDiscoveryParams {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  activeWorkspaceTab?: WorkspaceTabActivation | null;
  isDesktop?: boolean;
}

interface CodexProjectDiscovery {
  discover(): Promise<void>;
}

interface DiscoveryScope {
  scope: object;
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  services: ReturnType<typeof useWorkspaceServicesResolution>["services"];
  rpcReady: boolean;
}

/**
 * 显式项目激活/回焦只触发只读 native session/list。
 * UI 不保存列表结果，也不修复订阅；Host 在响应后统一失效现有 index subscribers。
 */
export function useCodexProjectDiscovery({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  activeWorkspaceTab,
  isDesktop = false,
}: CodexProjectDiscoveryParams): CodexProjectDiscovery {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
  const normalizedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const enabled = Boolean(isDesktop && activeWorkspaceTab && workspacePath);
  // activeWorkspaceTab 只做“确有项目被激活”的门禁；实际重扫描边界由 path、identity、
  // remote session 和 services 决定，避免 tab 元数据对象重建触发重复发现。
  const scope = useMemo<DiscoveryScope>(
    () => ({
      scope: {},
      enabled,
      workspacePath: workspacePath!,
      workspaceIdentity: normalizedWorkspaceIdentity,
      remoteSessionId: normalizedRemoteSessionId,
      services: resolution.services,
      rpcReady: resolution.rpcReady,
    }),
    [
      enabled,
      normalizedRemoteSessionId,
      normalizedWorkspaceIdentity,
      resolution.rpcReady,
      resolution.services,
      workspacePath,
    ],
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(false);
  const inflightRef = useRef<{ scope: object; request: Promise<void> } | null>(null);
  const contextServices = useOptionalServices();
  const platform = useOptionalPlatform();
  const projectDirectory = useOptionalProjectDirectory();
  const knownProjectRootsRef = useRef<Set<string> | null>(null);
  const projectRootInflightRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isDesktop || !projectDirectory) return;
    const hostsById = new Map(projectDirectory.directory.hosts.map((host) => [host.id, host]));
    const nextRoots = new Map<
      string,
      { workspacePath: string; workspaceIdentity?: string; hostId: string }
    >();
    for (const project of projectDirectory.projects) {
      if (project.deleted) continue;
      for (const root of project.roots) {
        const workspaceIdentity =
          project.hostId === "local"
            ? undefined
            : buildRemoteHostWorkspaceIdentity(project.hostId, root.rootPath);
        const key = workspaceIdentity ?? root.rootPath;
        if (!nextRoots.has(key)) {
          nextRoots.set(key, {
            workspacePath: root.rootPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            hostId: project.hostId,
          });
        }
      }
    }
    // 修复原因（issue #24）：若应用启动时尚无任何已保存项目（首次基线为空），用户在 projectDirectory
    // 首轮读取完成的同时或之前添加单目录项目，不能将新增 root 误当作冷启动存量跳过；
    // 当 loading 仍为 true 且尚未建立基线时，先把空基线落位，待后续加载/创建出的新 root 进入扫描。
    if (projectDirectory.loading && !knownProjectRootsRef.current) {
      if (nextRoots.size === 0) {
        knownProjectRootsRef.current = new Set();
      }
      return;
    }
    if (projectDirectory.loading) return;
    const previous = knownProjectRootsRef.current;
    knownProjectRootsRef.current = new Set(nextRoots.keys());
    if (!previous) return;

    const activeKey = scope.enabled ? (scope.workspaceIdentity ?? scope.workspacePath) : null;
    for (const [key, target] of nextRoots) {
      if (previous.has(key)) continue;
      if (key === activeKey) {
        void discover();
        continue;
      }
      if (projectRootInflightRef.current.has(key)) continue;
      let completed = false;
      const request = (async () => {
        if (target.hostId === "local") {
          const localServices =
            useRemoteWorkspaceSessionStore.getState().baseServices ??
            contextServices ??
            (scope.workspaceIdentity ? undefined : scope.services);
          if (!localServices?.codezSessionService) return;
          await localServices?.codezSessionService?.listSessions({
            workspacePath: target.workspacePath,
          });
          completed = true;
          return;
        }
        const workspaceIdentity = target.workspaceIdentity!;
        const existingSession = Object.values(
          useRemoteWorkspaceSessionStore.getState().sessionsById,
        ).find((session) => session.workspaceIdentity?.trim() === workspaceIdentity);
        if (existingSession?.services.codezSessionService) {
          await existingSession.services.codezSessionService.listSessions({
            workspacePath: target.workspacePath,
            workspaceIdentity,
          });
          completed = true;
          return;
        }
        const parsed = parseRemoteWorkspaceIdentity(workspaceIdentity);
        const sourceServerId = parsed?.kind === "server" ? parsed.sourceServerId : undefined;
        if (!sourceServerId) return;
        if (
          !getSourceSettingsServices(sourceServerId) &&
          platform?.requestSourceSettingsAttachment
        ) {
          await ensureSourceSettingsServices(
            sourceServerId,
            platform.requestSourceSettingsAttachment,
          );
        }
        if (!mountedRef.current) return;
        const sourceServices = getSourceSettingsServices(sourceServerId);
        if (!sourceServices?.codezSessionService) return;
        const host = hostsById.get(target.hostId);
        const legacyRouteHint = host?.target
          ? buildRemoteWorkspaceIdentity(target.workspacePath, host.target)
          : undefined;
        await sourceServices.sourceServerWorkspaceService?.resolveWorkspace({
          workspacePath: target.workspacePath,
          ...(legacyRouteHint ? { legacyRouteHint } : {}),
        });
        if (!mountedRef.current) return;
        await sourceServices.codezSessionService.listSessions({
          workspacePath: target.workspacePath,
          workspaceIdentity,
        });
        completed = true;
      })()
        .catch((error: unknown) => {
          if (!mountedRef.current) return;
          logger.warn("[CodexProjectDiscovery] 项目会话发现失败", {
            error,
            workspacePath: target.workspacePath,
          });
        })
        .finally(() => {
          if (!completed) {
            knownProjectRootsRef.current?.delete(key);
          }
          if (projectRootInflightRef.current.get(key) === request) {
            projectRootInflightRef.current.delete(key);
          }
        });
      projectRootInflightRef.current.set(key, request);
    }
  }, [
    contextServices,
    isDesktop,
    platform,
    projectDirectory,
    scope.enabled,
    scope.services,
    scope.workspaceIdentity,
    scope.workspacePath,
  ]);

  const discover = useCallback(async (): Promise<void> => {
    const current = scopeRef.current;
    if (!current.enabled || !current.rpcReady) return;
    if (inflightRef.current?.scope === current.scope) return inflightRef.current.request;
    const request = current.services.codezSessionService
      .listSessions({
        workspacePath: current.workspacePath,
        ...(current.workspaceIdentity ? { workspaceIdentity: current.workspaceIdentity } : {}),
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        // 后台发现不能阻塞项目打开。旧 scope/已卸载的迟到异常完全丢弃；
        // 当前 scope 的可恢复失败仅记录生产日志，交由下一次显式激活/回焦重试。
        if (scopeRef.current !== current || !mountedRef.current) return;
        logger.warn("[CodexProjectDiscovery] 项目会话发现失败", {
          error,
          workspacePath: current.workspacePath,
        });
      })
      .finally(() => {
        if (inflightRef.current?.scope === current.scope) inflightRef.current = null;
      });
    inflightRef.current = { scope: current.scope, request };
    return request;
  }, []);

  useEffect(() => {
    if (!scope.enabled) return;
    void discover();
    const onFocus = () => {
      void discover();
    };
    // 原因：新建项目可能复用当前已激活的 A tab；仅监听 workspacePath 变化
    // 不会再扫描 A 的外部 CLI 历史。当挂载在 ProjectDirectoryProvider 内时，
    // 新增 root 已由上方 nextRoots 对比精确触发（避免 RolloutSyncer/TaskIndexSyncer
    // 广播 state:projects 时造成全量 session/list 发现风暴）；仅在无 projectDirectory
    // 上下文时回退监听 state:projects。
    const changes = scope.services.broadcastService.onMessage((message) => {
      if (message.channel === "state:projects" && !projectDirectory) void discover();
    });
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      changes.dispose();
    };
  }, [discover, projectDirectory, scope]);

  return { discover };
}
