import { sanitizeRemoteConnectionLog, remoteConnectionFailureLogLevel } from "@codez/shared";
/* eslint-disable max-lines -- Main 的完整薄转发契约集中维护请求与端口关联。 */
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  buildSshRemoteHostKey,
  buildServerRemoteWorkspaceIdentity,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  PlatformChannels,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  resolveWorkspaceKey,
  scopedServicePortPayloadSchema,
  type BindRemoteWorkspaceSessionContextResult,
  type RemoteTarget,
  type ProviderProvisioningTrigger,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
  type WebRemoteControlFailure,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
} from "@codez/shared";
import type {
  RemoteConnectionStats,
  RemoteDisconnectReason,
  RemoteGaugeTransition,
} from "./desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import { ProviderProvisioningEnvironmentCoordinator } from "./providerProvisioningEnvironmentCoordinator.js";

interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

interface RemoteWorkspaceConnectContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  confirmSourceServerInstall?: boolean;
}

interface PendingConnect {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  remoteUsageTelemetryEligible: boolean;
  resolve: (sessionId: string) => void;
  onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
  reject: (error: Error) => void;
}

interface PendingWorkspaceBind {
  resolve: (previousWorkspaceIdentity?: string) => void;
  reject: (error: Error & { code?: string; retryable?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkspaceContextBindFlight {
  contextKey: string;
  promise: Promise<BindRemoteWorkspaceSessionContextResult>;
}

interface RemoteAttachmentRoute {
  /** 手机创建的目录 scope 不自动建立桌面 tab；桌面显式 join 后才提升。 */
  mobileOnly?: boolean;
  providerProvisioningReady?: Promise<void>;
  /** 首次桌面采用的唯一门禁，发布 route 前登记，覆盖 key 安装到 renderer ACK。 */
  firstRendererAttach?: PromiseWithResolvers<void>;
  webContentsId: number;
  // Main 只保留端口转发所需的 request/session 关联和脱敏 descriptor；连接/任务事实归 Host。
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    ready: () => Promise<void>;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "attachable" | "closed";
  connectedAtMonotonicMs: number;
  connectFinalized: boolean;
  remoteUsageTelemetryEligible: boolean;
  providerProvisioningDispose?: () => void;
}

interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly remoteSessionId: string;
  readonly trigger: ProviderProvisioningTrigger;
  readonly operation: ProviderProvisioningOperation;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

type ProviderProvisioningOperation =
  | "sync"
  | "install-runtime-keys"
  | "codex-key-rotation-begin"
  | "install-codex-runtime-keys";

function normalizeServerRemoteUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "docker":
      return right.kind === "docker" && left.container === right.container;
    case "server":
      return (
        right.kind === "server" &&
        normalizeServerRemoteUrlForComparison(left.url) ===
          normalizeServerRemoteUrlForComparison(right.url)
      );
  }
}

function buildRemoteTargetTelemetryKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "default"}\0${target.user?.trim() ?? ""}`;
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${normalizeServerRemoteUrlForComparison(target.url)}`;
  }
}

function closeMessagePort(port: MessagePortMain | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // MessagePort 关闭失败不影响 Host 内 attachment 的 close/dispose 幂等收口。
  }
}

export function createRemoteWorkspaceSessionManager(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => {
    port1: MessagePortMain;
    port2: MessagePortMain;
  };
  rendererAttachmentReadyTimeoutMs?: number;
  workspaceBindReadyTimeoutMs?: number;
  reportRemoteConnectionStateChanged?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    transition: Exclude<RemoteGaugeTransition, "none">;
  }) => void;
  reportRemoteDisconnect?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    disconnectReason: RemoteDisconnectReason;
    durationMs: number;
  }) => void;
  monotonicNowMs?: () => number;
  webRemoteControlManagerRef: {
    current: {
      failRemoteSession(sessionId: string, reason: string, failure: WebRemoteControlFailure): void;
      replaceRemoteSession?(event: {
        previousSessionId: string;
        sessionId: string;
        workspacePath: string;
        workspaceIdentity: string;
      }): Promise<void>;
    } | null;
  };
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}) {
  const pendingByRequestKey = new Map<string, PendingConnect>();
  const pendingProjectNavigations = new Map<
    string,
    {
      child: ElectronUtilityProcess;
      win: BrowserWindow;
      requestId: string;
      resolve(value: HostPreparedProjectWorkspace): void;
      reject(error: Error): void;
    }
  >();
  const pendingWorkspaceBindsByRequestKey = new Map<string, PendingWorkspaceBind>();
  const workspaceContextBindFlightsBySessionId = new Map<string, WorkspaceContextBindFlight>();
  const routesBySessionId = new Map<string, RemoteAttachmentRoute>();
  const listenedHosts = new WeakSet<ElectronUtilityProcess>();
  const workspaceBindReadyTimeoutMs = options.workspaceBindReadyTimeoutMs ?? 30_000;
  const pendingProviderProvisioningExecutions = new Map<
    string,
    PendingProviderProvisioningExecution
  >();
  const providerProvisioningCoordinator =
    options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator();
  let appShutdownStarted = false;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  function requestKey(webContentsId: number, requestId: string): string {
    return `${webContentsId}\0${requestId}`;
  }

  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`未找到窗口 Local Host，windowId=${win.webContents.id}`);
    }
    ensureHostListener(child, win.webContents.id);
    return child;
  }

  function createMessageChannel() {
    return options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: sanitizeRemoteConnectionLog(payload.message),
      // Bugfix: R1 改造曾把完整 ISO 时间直接交给连接日志 UI，长时间戳会挤压 flex 日志列并换行。
      // 这里恢复既有的紧凑时钟展示契约，Host 的 requestId 路由和原始日志内容保持不变。
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // 候选 port 的回收属于幂等清理，不能因 Host 已退出导致 ready promise 再次悬空。
      options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法 attachment 远程 workspace");
    }
    if (
      routesBySessionId.get(route.descriptor.remoteSessionId) !== route ||
      route.attachmentState !== "attachable"
    )
      throw new Error("远程 workspace scope 已失效，不能创建 attachment");
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `远程 descriptor 缺少 workspace scope，sessionId=${descriptor.remoteSessionId}`,
      );
    }
    const attachmentId = randomUUID();
    const rendererPayload = scopedServicePortPayloadSchema.parse({
      attachmentId,
      sessionId: descriptor.remoteSessionId,
      target: descriptor.target,
      ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      ...(descriptor.workspacePurpose ? { workspacePurpose: descriptor.workspacePurpose } : {}),
    });
    const { port1, port2 } = createMessageChannel();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(`renderer attachment 已被后续换代替代，sessionId=${descriptor.remoteSessionId}`),
      );
    }

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready 超时，sessionId=${descriptor.remoteSessionId}`,
        );
        options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        ready: () => ready,
        timeout,
        resolve,
        reject,
      };

      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ScopedServicePort, rendererPayload, [port1]);
      } catch (error) {
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return ready;
  }

  function waitForRendererAttachmentReady(route: RemoteAttachmentRoute): Promise<void> {
    if (route.firstRendererAttach && !route.connectFinalized)
      return route.firstRendererAttach.promise;
    if (route.pendingRendererAttachment) {
      return route.pendingRendererAttachment.ready();
    }
    if (route.rendererAttachmentId) {
      return Promise.resolve();
    }
    return Promise.reject(
      new Error(
        `远程 workspace route 尚无可用 renderer attachment，sessionId=${route.descriptor.remoteSessionId}`,
      ),
    );
  }

  async function prepareFirstRendererAttachment(
    child: ElectronUtilityProcess,
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    initialSync: Promise<void>,
    reason: string,
  ): Promise<void> {
    const descriptor = route.descriptor;
    const flight = route.firstRendererAttach;
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const assertCurrent = () => {
      if (
        routesBySessionId.get(descriptor.remoteSessionId) !== route ||
        route.descriptor !== descriptor ||
        route.firstRendererAttach !== flight ||
        route.attachmentState !== "attachable"
      )
        throw new Error("远程 workspace 已关闭，首次 attachment 结果已失效");
    };
    // 首连和 mobileOnly 首次桌面采用共享同一准备顺序；Key 不经过 Main，只等待所属 Host ACK。
    await (codexKeyRotations.get(environmentKey)?.hold ?? Promise.resolve());
    await initialSync;
    assertCurrent();
    await executeProviderProvisioning(
      child,
      descriptor.remoteSessionId,
      environmentKey,
      "environment-online",
      "install-runtime-keys",
    );
    assertCurrent();
    await executeProviderProvisioning(
      child,
      descriptor.remoteSessionId,
      environmentKey,
      "environment-online",
      "install-codex-runtime-keys",
    );
    assertCurrent();
    await attachRendererPort(win, route, reason);
    assertCurrent();
  }

  function buildWorkspaceContextBindKey(params: {
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
  }): string {
    return `${params.workspaceIdentity}\0${params.workspacePurpose ?? ""}`;
  }

  function waitForJoinedRouteReady(
    route: RemoteAttachmentRoute,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): Promise<void> {
    const bindFlight = workspaceContextBindFlightsBySessionId.get(descriptor.remoteSessionId);
    if (
      bindFlight &&
      descriptor.workspaceIdentity &&
      bindFlight.contextKey ===
        buildWorkspaceContextBindKey({
          workspaceIdentity: descriptor.workspaceIdentity,
          workspacePurpose: descriptor.workspacePurpose,
        })
    ) {
      return bindFlight.promise.then(() => undefined);
    }
    return waitForRendererAttachmentReady(route);
  }

  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    if (
      !route ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`窗口 Local Host 已退出，sessionId=${payload.sessionId}`));
      return;
    }
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind 会 fail-closed 立即失效 A；Main 仍需等 renderer 注册 B
      // 后再提升 route 并做幂等清理。reload 复挂没有 generation 换代，也因此不会提前拆掉可用旧 port。
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    if (!route.connectFinalized) {
      route.connectFinalized = true;
      if (route.remoteUsageTelemetryEligible) {
        reportRemoteRouteConnected(route);
      }
    }
    pending.resolve();
  }

  function reportRemoteRouteConnected(route: RemoteAttachmentRoute): void {
    try {
      options.reportRemoteConnectionStateChanged?.({
        rendererId: route.webContentsId,
        remoteKind: route.descriptor.target.kind,
        transition: "connected",
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connected reporter failed", {
        error,
      });
    }
  }

  function settleConnectedRequest(
    pending: PendingConnect,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    try {
      pending.onConnected?.(descriptor);
      pending.resolve(descriptor.remoteSessionId);
    } catch (error) {
      // 观察者异常只拒绝自己的 waiter，不能让共享连接悬挂或回收其他 caller 的健康 route。
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingByRequestKey.get(key);
    if (!pending) {
      // 旧请求的迟到 join 可能返回新 owner 正在使用的 session；缺 waiter 不授权回收健康 route。
      if (routesBySessionId.has(descriptor.remoteSessionId)) return;
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    pendingByRequestKey.delete(key);
    const existingRoute = routesBySessionId.get(descriptor.remoteSessionId);
    if (existingRoute) {
      if (
        existingRoute.webContentsId !== webContentsId ||
        existingRoute.attachmentState !== "attachable" ||
        !isSameRemoteTarget(existingRoute.descriptor.target, descriptor.target)
      ) {
        // Bug 原因：Host join 合法复用 logical sessionId；只有同窗口、同 target 才能共享
        // Main route。冲突时拒绝新请求，但不能 dispose 仍被旧 owner 使用的 session。
        pending.reject(
          new Error(
            `远程 workspace join 与已有 route 不匹配，sessionId=${descriptor.remoteSessionId}`,
          ),
        );
        return;
      }
      if (existingRoute.mobileOnly) {
        const previousTelemetryEligibility = existingRoute.remoteUsageTelemetryEligible;
        const flight = Promise.withResolvers<void>();
        existingRoute.firstRendererAttach = flight;
        existingRoute.mobileOnly = false;
        // 手机 scope 没有 renderer ready；桌面采用时重新走唯一的连接提交点。
        existingRoute.connectFinalized = false;
        existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
        void flight.promise.then(
          () => {
            settleConnectedRequest(pending, descriptor);
          },
          (error: unknown) =>
            pending.reject(error instanceof Error ? error : new Error(String(error))),
        );
        void prepareFirstRendererAttachment(
          child,
          pending.win,
          existingRoute,
          existingRoute.providerProvisioningReady ?? Promise.resolve(),
          "desktop-join",
        ).then(flight.resolve, (error: unknown) => {
          flight.reject(error);
          // 桌面只拥有本次 candidate；采用失败不能回收手机仍持有的 replayable session。
          if (
            routesBySessionId.get(descriptor.remoteSessionId) === existingRoute &&
            existingRoute.firstRendererAttach === flight &&
            existingRoute.descriptor.remoteSessionId === descriptor.remoteSessionId &&
            existingRoute.attachmentState === "attachable"
          ) {
            existingRoute.mobileOnly = true;
            existingRoute.connectFinalized = true;
            existingRoute.remoteUsageTelemetryEligible = previousTelemetryEligibility;
            existingRoute.firstRendererAttach = undefined;
          }
        });
        return;
      }
      // Bug 原因：显式 conversation bind 与 Source 自动恢复可能 join 到同一个 Host
      // logical session。过去这里覆盖 routesBySessionId，旧 candidate 的 ready ACK 会被
      // 判 stale，遗留 timer 最终又回收健康 attachment。重复 connect 只等待唯一 route ready。
      const promoteTelemetryEligibility =
        !existingRoute.remoteUsageTelemetryEligible && pending.remoteUsageTelemetryEligible;
      existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
      if (promoteTelemetryEligibility && existingRoute.connectFinalized) {
        reportRemoteRouteConnected(existingRoute);
      }
      void waitForJoinedRouteReady(existingRoute, descriptor).then(
        () => {
          settleConnectedRequest(pending, descriptor);
        },
        (error: unknown) =>
          pending.reject(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const route: RemoteAttachmentRoute = {
      firstRendererAttach: Promise.withResolvers<void>(),
      webContentsId,
      descriptor,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: false,
      remoteUsageTelemetryEligible: pending.remoteUsageTelemetryEligible,
    };
    const flight = route.firstRendererAttach!;
    // 修复原因：route 已可 join 时 provisioning 尚未投递 port，旧 join/bind 会立即报“无 attachment”。
    // 修复依据：同步登记首挂门禁，再发布 route；所有 caller 只等待同一条 renderer ACK 链。
    void flight.promise.then(
      () => {
        settleConnectedRequest(pending, descriptor);
      },
      (error: unknown) => pending.reject(error instanceof Error ? error : new Error(String(error))),
    );
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    // Codex 临时 Key 轮换期间，新连接必须等屏障解除后再安装/发布 ready，
    // 否则它可能在配置与凭据的中间态拿到旧事实。
    void prepareFirstRendererAttachment(
      child,
      pending.win,
      route,
      registration.initialSync,
      "connect",
    )
      .then(() => {
        if (
          routesBySessionId.get(descriptor.remoteSessionId) !== route ||
          route.firstRendererAttach !== flight ||
          route.attachmentState !== "attachable"
        )
          return;
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已连接`,
        });
        flight.resolve();
      })
      .catch((error: unknown) => {
        flight.reject(error instanceof Error ? error : new Error(String(error)));
        if (
          routesBySessionId.get(descriptor.remoteSessionId) === route &&
          route.firstRendererAttach === flight &&
          route.descriptor.remoteSessionId === descriptor.remoteSessionId &&
          route.attachmentState === "attachable"
        ) {
          disposeRemoteWorkspaceSession(descriptor.remoteSessionId);
        }
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function handleReconnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    previousRemoteSessionId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const route = routesBySessionId.get(previousRemoteSessionId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (!route || route.webContentsId !== webContentsId || !win) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    routesBySessionId.delete(previousRemoteSessionId);
    route.firstRendererAttach?.reject(new Error("远程 workspace 首挂已被 Source 换代取消"));
    route.firstRendererAttach = undefined;
    route.descriptor = descriptor;
    route.attachmentState = "attachable";
    routesBySessionId.set(descriptor.remoteSessionId, route);
    // Bug 原因：Provisioning lane 以 remoteSessionId 登记，execute 闭包也绑定旧 sessionId；
    // Source 重连换代后若不重新登记，后续下发都会命中 Host 已失效的旧 session，远端再也收不到配置。
    // 先摘掉旧登记再登记新 session，让 lane 按 Environment 重新上线整份重下发（离线期间的本机
    // 配置变更由此补齐）；重连不是首连发布屏障，失败只记录 warning，不拆除已恢复的 Workspace。
    route.providerProvisioningDispose?.();
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    registration.initialSync.catch((error: unknown) => {
      options.logger.warn(
        "[provider-provisioning] Environment resync after reconnect did not apply",
        {
          environmentKey,
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
    void (
      route.mobileOnly
        ? Promise.resolve()
        : attachRendererPort(win, route, "source-server-reconnected")
    )
      .then(() => {
        if (
          routesBySessionId.get(descriptor.remoteSessionId) !== route ||
          route.descriptor !== descriptor ||
          route.attachmentState !== "attachable"
        )
          return;
        if (!descriptor.workspacePath || !descriptor.workspaceIdentity) return;
        // Bug 原因：手机 bridge 换代曾被 await 在 Desktop 关键路径上，手机 attachment
        // 失败会落入外层 catch 并 dispose 已就绪的 Desktop session。Desktop continuous
        // 先完成换代；手机 replayable 恢复是隔离的旁路，失败只降级手机。
        if (!route.mobileOnly)
          win.webContents.send(PlatformChannels.RemoteSessionReconnected, {
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          });
        emitConnectionLog(win, {
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已自动重连`,
        });
        void options.webRemoteControlManagerRef.current
          ?.replaceRemoteSession?.({
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          })
          .catch((error: unknown) => {
            options.logger.warn("[window-host-remote] mobile bridge recovery failed", {
              previousRemoteSessionId,
              remoteSessionId: descriptor.remoteSessionId,
              error,
            });
          });
      })
      .catch((error: unknown) => {
        // renderer ACK 换代失败仅回收自己持有的代际，不能拆掉后续 reconnect 的 route。
        if (
          routesBySessionId.get(descriptor.remoteSessionId) === route &&
          route.descriptor === descriptor &&
          route.attachmentState === "attachable"
        )
          disposeRemoteWorkspaceSession(descriptor.remoteSessionId);
        options.logger.warn("[window-host-remote] Source reconnect attachment failed", {
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error,
        });
      });
  }

  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
    operation: ProviderProvisioningOperation = "sync",
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingProviderProvisioningExecutions.set(requestId, {
        child,
        remoteSessionId,
        trigger,
        operation,
        startedAtMonotonicMs: monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
          operation,
        });
      } catch (error) {
        pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Codex 原生临时 Key 的 Environment 级轮换屏障（spec: codex-provider-runtime-env-key）。
   * Main 只协调代际与逐连接 ACK；Key 值由每个 Window Host 现读本机凭据并直传其
   * Remote Host，不经过 Main。hold 存续期间新连接不得 ready；发起方 Host 退出即释放。
   */
  const codexKeyRotations = new Map<
    string,
    {
      hold: Promise<void>;
      release: () => void;
      originChild: ElectronUtilityProcess;
    }
  >();

  function codexKeyRotationRoutes(environmentKey: string): RemoteAttachmentRoute[] {
    return [...routesBySessionId.values()].filter(
      (route) =>
        route.attachmentState === "attachable" &&
        buildRemoteEnvironmentKey(route.descriptor.target) === environmentKey,
    );
  }

  function executeCodexKeyOperation(
    route: RemoteAttachmentRoute,
    environmentKey: string,
    operation: ProviderProvisioningOperation,
  ): Promise<void> {
    const owner = options.windowHostProcessMap.get(route.webContentsId);
    if (!owner) return Promise.reject(new Error("窗口 Host 已退出"));
    return executeProviderProvisioning(
      owner,
      route.descriptor.remoteSessionId,
      environmentKey,
      "credential",
      operation,
    );
  }

  async function coordinateCodexKeyRotation(
    originChild: ElectronUtilityProcess,
    environmentKey: string,
    phase: "begin" | "commit" | "rollback",
  ): Promise<void> {
    const routes = codexKeyRotationRoutes(environmentKey);
    if (phase === "begin") {
      if (codexKeyRotations.has(environmentKey)) {
        throw new Error("该远程环境的供应商 Key 正在更新，请稍后重试");
      }
      const results = await Promise.allSettled(
        routes.map((route) =>
          executeCodexKeyOperation(route, environmentKey, "codex-key-rotation-begin"),
        ),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        // 部分连接已进入屏障：用当前事实安装并解除，避免持续 fail-closed。
        await Promise.allSettled(
          routes.map((route) =>
            executeCodexKeyOperation(route, environmentKey, "install-codex-runtime-keys"),
          ),
        );
        throw new Error(`无法更新供应商 Key：${failures.length} 个远程连接未能停止旧运行时`);
      }
      // begin 成功后才建立 hold；随后 connect 的新连接会等待本 promise。
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      codexKeyRotations.set(environmentKey, { hold, release, originChild });
      return;
    }
    // commit / rollback：把当前注册表+凭据事实安装到每条在线连接并解除屏障。
    const rotation = codexKeyRotations.get(environmentKey);
    const results = await Promise.allSettled(
      routes.map((route) =>
        executeCodexKeyOperation(route, environmentKey, "install-codex-runtime-keys"),
      ),
    );
    if (rotation) {
      codexKeyRotations.delete(environmentKey);
      // hold 的释放在 fan-out 之后：等待中的新连接读到的是安装完成的最新事实。
      rotation.release();
    }
    const failedRoutes = results
      .map((result, index) => ({ result, route: routes[index] }))
      .filter(
        (
          entry,
        ): entry is {
          result: PromiseRejectedResult;
          route: RemoteAttachmentRoute;
        } => entry.result.status === "rejected" && entry.route !== undefined,
      );
    for (const { route } of failedRoutes) {
      // 安装失败的连接不能继续使用旧 Key：关闭该连接，重连时重新读取本机最新凭据。
      handleClosed(route.webContentsId, {
        remoteSessionId: route.descriptor.remoteSessionId,
        reason: "connection-closed",
        error: "临时 Key 安装失败",
      });
      options.windowHostProcessMap.get(route.webContentsId)?.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: route.descriptor.remoteSessionId,
      });
    }
    if (failedRoutes.length > 0) {
      throw new Error(`临时 Key 安装失败，已断开 ${failedRoutes.length} 个连接；重新连接后生效`);
    }
  }

  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
  }

  function retireActiveRoute(
    route: RemoteAttachmentRoute,
    reason: RemoteDisconnectReason,
    mutate: () => void,
  ): void {
    const wasActive =
      route.remoteUsageTelemetryEligible &&
      route.attachmentState === "attachable" &&
      route.connectFinalized;
    mutate();
    // close/dispose/Host/window 退出不能等待未返回的 provisioning 才结算首挂 caller。
    route.firstRendererAttach?.reject(new Error(`远程 workspace 已关闭，首挂已终止 (${reason})`));
    const child = options.windowHostProcessMap.get(route.webContentsId);
    for (const [requestId, execution] of pendingProviderProvisioningExecutions) {
      if (
        execution.child !== child ||
        execution.remoteSessionId !== route.descriptor.remoteSessionId
      )
        continue;
      pendingProviderProvisioningExecutions.delete(requestId);
      execution.reject(new Error("远程 workspace 已关闭，Provider Provisioning 结果已失效"));
    }
    if (!wasActive) return;

    const common = {
      rendererId: route.webContentsId,
      remoteKind: route.descriptor.target.kind,
    };
    try {
      options.reportRemoteConnectionStateChanged?.({
        ...common,
        transition: reason,
      });
    } catch (error) {
      // telemetry 是连接生命周期的旁路，不能因 reporter 异常回滚 route 退出状态。
      options.logger.warn("[remote-usage-arms] disconnect gauge reporter failed", { error });
    }
    try {
      options.reportRemoteDisconnect?.({
        ...common,
        disconnectReason: reason,
        durationMs: Math.max(0, Math.round(monotonicNowMs() - route.connectedAtMonotonicMs)),
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] disconnect reporter failed", {
        error,
      });
    }
  }

  function handleClosed(
    webContentsId: number,
    event: {
      remoteSessionId: string;
      reason: "connection-closed" | "disposed" | "connect-cancelled";
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
      recoverable?: boolean;
      recoveryAttempt?: number;
      recoveryLimit?: number;
      recoveryBudgetExhausted?: boolean;
      reasonCode?: string;
      retryable?: boolean;
    },
  ): void {
    const route = routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId) return;
    const closedChild = options.windowHostProcessMap.get(webContentsId);
    for (const [requestId, execution] of pendingProviderProvisioningExecutions) {
      if (execution.child !== closedChild || execution.remoteSessionId !== event.remoteSessionId) {
        continue;
      }
      pendingProviderProvisioningExecutions.delete(requestId);
      execution.reject(new Error("远程 workspace 已断开，Provider Provisioning 结果已失效"));
    }
    if (event.reason !== "connection-closed") {
      route.providerProvisioningDispose?.();
      retireActiveRoute(route, "disposed", () => {
        routesBySessionId.delete(event.remoteSessionId);
      });
      detachRouteAttachments(
        route,
        "session-released",
        new Error(`远程 workspace 已释放，sessionId=${event.remoteSessionId}`),
      );
      return;
    }
    retireActiveRoute(route, "connection-closed", () => {
      route.attachmentState = "closed";
    });
    route.providerProvisioningDispose?.();
    // 连接断开只把 route 标成 closed，已暴露的 desktop attachment 仍留在窗口 Host；
    // sessionId 换代后 Main 又会删除 route，导致旧 ChannelServer 永久失去回收入口。
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`远程 workspace 已关闭，sessionId=${event.remoteSessionId}`),
    );
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (event.recoverable !== true) {
      options.webRemoteControlManagerRef.current?.failRemoteSession(
        event.remoteSessionId,
        "window-host:connection-offline",
        {
          reason: "workspace-closed",
          message: "远程工作区连接已结束，请在桌面端重新连接。",
        },
      );
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        ...(event.error ? { error: event.error } : {}),
        ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
        ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
        ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
        ...(event.recoveryBudgetExhausted !== undefined
          ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
          : {}),
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      });
      emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "远程 workspace 连接已断开",
      });
    }
  }

  function acceptPreparedProjectWorkspace(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    result: { ok: true; value: HostPreparedProjectWorkspace } | { ok: false; error: string },
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingProjectNavigations.get(key);
    if (!pending || pending.child !== child) return;
    if (!result.ok) {
      pendingProjectNavigations.delete(key);
      pending.reject(new Error(result.error));
      return;
    }
    const descriptor = result.value.remote;
    if (!descriptor) {
      pendingProjectNavigations.delete(key);
      pending.resolve(result.value);
      return;
    }
    const resolveWhenReady = (route: RemoteAttachmentRoute, ownsRegistration: boolean) => {
      void (route.providerProvisioningReady ?? Promise.resolve()).then(
        () => {
          // 每个 join 都必须等同一屏障，并保留自己的取消资格到成功提交。
          if (pendingProjectNavigations.get(key) !== pending) return;
          pendingProjectNavigations.delete(key);
          if (
            routesBySessionId.get(descriptor.remoteSessionId) !== route ||
            route.attachmentState !== "attachable"
          )
            pending.reject(new Error("项目导航 scope 已失效"));
          else pending.resolve(result.value);
        },
        (error: unknown) => {
          if (pendingProjectNavigations.get(key) === pending) pendingProjectNavigations.delete(key);
          if (
            ownsRegistration &&
            routesBySessionId.get(descriptor.remoteSessionId) === route &&
            route.mobileOnly
          ) {
            routesBySessionId.delete(descriptor.remoteSessionId);
            route.providerProvisioningDispose?.();
            child.postMessage({
              type: HostMessageTypes.DisposeRemoteWorkspaceSession,
              requestId: randomUUID(),
              remoteSessionId: descriptor.remoteSessionId,
            });
          }
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    const existing = routesBySessionId.get(descriptor.remoteSessionId);
    if (existing) {
      if (
        existing.webContentsId !== webContentsId ||
        existing.attachmentState !== "attachable" ||
        existing.descriptor.workspaceIdentity !== descriptor.workspaceIdentity ||
        existing.descriptor.workspacePath !== descriptor.workspacePath
      ) {
        pendingProjectNavigations.delete(key);
        pending.reject(new Error("Project navigation scope conflicts with existing route"));
      } else resolveWhenReady(existing, false);
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      mobileOnly: true,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: true,
      remoteUsageTelemetryEligible: false,
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    route.providerProvisioningReady = registration.initialSync;
    resolveWhenReady(route, true);
  }

  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (listenedHosts.has(child)) return;
    listenedHosts.add(child);
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HostResponseTypes.ProjectWorkspacePrepared) {
        acceptPreparedProjectWorkspace(
          child,
          webContentsId,
          parsed.data.requestId,
          parsed.data.result,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = pendingByRequestKey.get(requestKey(webContentsId, parsed.data.requestId));
        if (!pending) return;
        // 多个远程连接共享 window Host，不能再从进程 label/stdout 猜日志归属；
        // Host 已带上连接 requestId，Main 只向对应发起窗口做薄转发。
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.CodexProviderKeyRotationRequest) {
        const request = parsed.data;
        void coordinateCodexKeyRotation(child, request.environmentKey, request.phase)
          .then(() => {
            child.postMessage({
              type: HostMessageTypes.CodexProviderKeyRotationResult,
              requestId: request.requestId,
              ok: true,
            });
          })
          .catch((error: unknown) => {
            child.postMessage({
              type: HostMessageTypes.CodexProviderKeyRotationResult,
              requestId: request.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        const trigger = parsed.data.trigger;
        void providerProvisioningCoordinator
          .requestAll(trigger)
          .then(async () => {
            // 配置事实只同步一次；临时 Key 是每条在线连接自己的内存事实，不能由
            // Environment single-flight lane 的那个 Host 代替其它 Window Host 安装。
            await Promise.all(
              [...routesBySessionId.values()]
                .filter((route) => route.attachmentState === "attachable")
                .map(async (route) => {
                  const owner = options.windowHostProcessMap.get(route.webContentsId);
                  if (!owner) return;
                  try {
                    await executeProviderProvisioning(
                      owner,
                      route.descriptor.remoteSessionId,
                      buildRemoteEnvironmentKey(route.descriptor.target),
                      trigger,
                      "install-runtime-keys",
                    );
                  } catch {
                    // Key 变更后安装失败不能让旧 Agent 继续接受新输入；关闭该连接，
                    // 由现有 stdio 生命周期回收旧进程，重连时重新读取本机最新凭据。
                    handleClosed(route.webContentsId, {
                      remoteSessionId: route.descriptor.remoteSessionId,
                      reason: "connection-closed",
                      error: "临时 Key 安装失败",
                    });
                    owner.postMessage({
                      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
                      requestId: randomUUID(),
                      remoteSessionId: route.descriptor.remoteSessionId,
                    });
                  }
                }),
            );
          })
          .catch((error: unknown) => {
            options.logger.warn("[provider-provisioning] runtime key install failed", { error });
          });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        if (!pending || pending.child !== child) return;
        pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const logContext = {
          environmentKey: parsed.data.environmentKey,
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          const errorCode =
            parsed.data.errorCode ??
            (parsed.data.status === "unsupported"
              ? "capability-unavailable"
              : "target-apply-failed");
          // 首次失败以前在 warning 前返回，连接面板也只剩开始日志，无法区分本地与远端故障。
          // 仅记录经过 schema 校验的阶段码；远端 error 自由文本仍不进入日志或反馈。
          options.logger.warn("[provider-provisioning] Environment sync did not apply", {
            ...logContext,
            errorCode,
          });
          if (
            pending.trigger === "environment-online" ||
            pending.operation === "install-runtime-keys" ||
            pending.operation === "codex-key-rotation-begin" ||
            pending.operation === "install-codex-runtime-keys"
          ) {
            pending.reject(
              new Error(`Provider Provisioning 首次同步失败 (${parsed.data.status}; ${errorCode})`),
            );
            return;
          }
        } else {
          options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        }
        pending.resolve();
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      if (
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound ||
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindFailed
      ) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingWorkspaceBindsByRequestKey.get(key);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        if (parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound) {
          pending.resolve(parsed.data.previousWorkspaceIdentity);
        } else {
          const error = new Error(parsed.data.error) as Error & {
            code?: string;
            retryable?: boolean;
          };
          if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
          if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
          pending.reject(error);
        }
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceReconnected) {
        handleReconnected(
          child,
          webContentsId,
          parsed.data.previousRemoteSessionId,
          parsed.data.descriptor,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingByRequestKey.get(key);
        if (!pending) return;
        pendingByRequestKey.delete(key);
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: remoteConnectionFailureLogLevel(parsed.data.reasonCode ?? ""),
          message: sanitizeRemoteConnectionLog(parsed.data.error),
        });
        const error = new Error(parsed.data.error) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
        if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
        if (parsed.data.profileId) error.profileId = parsed.data.profileId;
        if (parsed.data.resolvedWslTarget) error.resolvedWslTarget = parsed.data.resolvedWslTarget;
        pending.reject(error);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        handleClosed(webContentsId, parsed.data);
      }
    });
    child.once("exit", () => {
      const error = new Error("窗口 Local Host 已退出");
      for (const [key, pending] of pendingProjectNavigations) {
        if (pending.child !== child) continue;
        pendingProjectNavigations.delete(key);
        pending.reject(error);
      }

      for (const [requestId, pendingExecution] of pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      // 发起方 Host 在轮换中途退出：解除 Environment 屏障，其余连接用当前本机事实
      // 重装并解除 fail-closed（best-effort；每个条目自身一致，缺值仍按缺凭据处理）。
      for (const [environmentKey, rotation] of codexKeyRotations) {
        if (rotation.originChild !== child) continue;
        codexKeyRotations.delete(environmentKey);
        rotation.release();
        for (const route of codexKeyRotationRoutes(environmentKey)) {
          void executeCodexKeyOperation(route, environmentKey, "install-codex-runtime-keys").catch(
            (installError: unknown) => {
              options.logger.warn("[codex-provider-key] release after origin host exit failed", {
                error: installError instanceof Error ? installError.message : String(installError),
              });
            },
          );
        }
      }
      for (const [key, pending] of Array.from(pendingByRequestKey)) {
        if (pending.webContentsId === webContentsId) {
          pendingByRequestKey.delete(key);
          pending.reject(error);
        }
      }
      for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
        if (!key.startsWith(`${webContentsId}\0`)) continue;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        if (route.webContentsId !== webContentsId) continue;
        route.providerProvisioningDispose?.();
        retireActiveRoute(route, "host-exit", () => {
          routesBySessionId.delete(sessionId);
        });
        if (route.pendingRendererAttachment) {
          clearTimeout(route.pendingRendererAttachment.timeout);
          route.pendingRendererAttachment.reject(error);
        }
      }
    });
  }

  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceConnectContext,
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ): Promise<string> {
    if (appShutdownStarted) {
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    const child = getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && options.resolveWslTarget
        ? await options.resolveWslTarget(target)
        : target;
    if (appShutdownStarted) {
      // WSL identity 解析跨 await，期间退出屏障可能已清空 Main 请求关联并开始回收 Host。
      // 恢复后必须重新验证生命周期，禁止在 shutdown barrier 之后注册迟到请求。
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法创建远程工作区连接");
    }
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    if (pendingByRequestKey.has(key)) {
      throw new Error(`远程连接 requestId 重复，requestId=${resolvedRequestId}`);
    }
    emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      message: `正在通过窗口 Host 连接 ${resolvedTarget.kind} workspace`,
    });
    // 资产契约失败必须发生在 pending 注册前，否则同步异常会泄漏请求关联。
    const remoteAssets = options.resolveRemoteAssetDirs();
    return new Promise<string>((resolve, reject) => {
      pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        win,
        remoteUsageTelemetryEligible: lifecycle?.remoteUsageTelemetryEligible ?? false,
        onConnected: lifecycle?.onConnected,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        ...(context?.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    });
  }

  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<BindRemoteWorkspaceSessionContextResult> {
    const route = routesBySessionId.get(sessionId);
    if (!route) {
      throw new Error(`未找到远程 workspace session，sessionId=${sessionId}`);
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(`远程 workspace session 不属于当前窗口，sessionId=${sessionId}`);
    }
    const requestedWorkspaceIdentity =
      context.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const workspaceIdentity = route.descriptor.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: route.descriptor.sourceServerId,
          workspacePath: context.workspacePath,
        })
      : requestedWorkspaceIdentity;
    const contextKey = buildWorkspaceContextBindKey({
      workspaceIdentity,
      workspacePurpose: context.workspacePurpose,
    });
    const existingFlight = workspaceContextBindFlightsBySessionId.get(sessionId);
    if (existingFlight) {
      if (existingFlight.contextKey !== contextKey) {
        throw new Error(`远程 workspace session 正在绑定其它 context，sessionId=${sessionId}`);
      }
      return await existingFlight.promise;
    }
    const requestedWorkspacePurpose = context.workspacePurpose ?? route.descriptor.workspacePurpose;
    if (
      route.descriptor.workspacePath === context.workspacePath &&
      route.descriptor.workspaceIdentity === workspaceIdentity &&
      (route.descriptor.workspacePurpose ?? "project") === (requestedWorkspacePurpose ?? "project")
    ) {
      // Bug 原因：join caller 在首个 bind 完成后会再次提交同一 context。重复换代
      // attachment 会让并行初始化使用的 services 失效；已绑定 context 只等待当前 candidate ready。
      await waitForRendererAttachmentReady(route);
      return createBoundRemoteWorkspaceContextResult(route);
    }
    const promise = performRemoteWorkspaceSessionContextBind({
      route,
      sessionId,
      context,
      requestedWorkspaceIdentity,
      workspaceIdentity,
    });
    workspaceContextBindFlightsBySessionId.set(sessionId, {
      contextKey,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = workspaceContextBindFlightsBySessionId.get(sessionId);
      if (current?.promise === promise) {
        workspaceContextBindFlightsBySessionId.delete(sessionId);
      }
    }
  }

  async function performRemoteWorkspaceSessionContextBind(params: {
    route: RemoteAttachmentRoute;
    sessionId: string;
    context: RemoteWorkspaceSessionContext;
    requestedWorkspaceIdentity: string;
    workspaceIdentity: string;
  }): Promise<BindRemoteWorkspaceSessionContextResult> {
    const { route, sessionId, context, requestedWorkspaceIdentity, workspaceIdentity } = params;
    if (route.firstRendererAttach && !route.connectFinalized)
      await route.firstRendererAttach.promise;
    if (
      routesBySessionId.get(sessionId) !== route ||
      route.descriptor.remoteSessionId !== sessionId ||
      route.attachmentState !== "attachable"
    )
      throw new Error("远程 workspace bind scope 已失效");
    const child = options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!child || !win) {
      throw new Error(`未找到远程 workspace 所属窗口 Host，sessionId=${sessionId}`);
    }
    const requestId = randomUUID();
    const bindRequestKey = requestKey(route.webContentsId, requestId);
    const bindReady = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceBind,
          requestId,
          remoteSessionId: sessionId,
        });
        pending.reject(
          Object.assign(
            new Error(
              `workspace bind ACK 超时，sessionId=${sessionId}, timeoutMs=${workspaceBindReadyTimeoutMs}`,
            ),
            {
              // Bug 原因：超时会主动发 CancelRemoteWorkspaceBind，但本地先拒绝了无 code 的
              // Error，Renderer 永远走不到已登记的 bindCanceled i18n 分支。
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: true,
            },
          ),
        );
      }, workspaceBindReadyTimeoutMs);
      pendingWorkspaceBindsByRequestKey.set(bindRequestKey, {
        resolve,
        reject,
        timeout,
      });
    });
    child.postMessage({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      requestId,
      remoteSessionId: sessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      ...(requestedWorkspaceIdentity !== workspaceIdentity
        ? { legacyRouteHint: requestedWorkspaceIdentity }
        : {}),
    });
    let previousWorkspaceIdentity: string | undefined;
    try {
      previousWorkspaceIdentity = await bindReady;
    } catch (error) {
      const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
      if (pending) clearTimeout(pending.timeout);
      pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
      throw error;
    }
    route.descriptor = {
      ...route.descriptor,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      generation: route.descriptor.generation + 1,
    };
    // 同一 parentPort 上 Bind 先于 Attach 处理；IPC 只在 renderer 注册新 port 后返回。
    await attachRendererPort(win, route, "workspace-context-bound");
    return createBoundRemoteWorkspaceContextResult(route, previousWorkspaceIdentity);
  }

  function createBoundRemoteWorkspaceContextResult(
    route: RemoteAttachmentRoute,
    previousWorkspaceIdentity?: string,
  ): BindRemoteWorkspaceSessionContextResult {
    return {
      ...(route.descriptor.sourceServerId
        ? { sourceServerId: route.descriptor.sourceServerId }
        : {}),
      remoteSessionId: route.descriptor.remoteSessionId,
      workspacePath: route.descriptor.workspacePath!,
      workspaceIdentity: route.descriptor.workspaceIdentity!,
      ...(route.descriptor.workspacePurpose
        ? { workspacePurpose: route.descriptor.workspacePurpose }
        : {}),
      ...(previousWorkspaceIdentity ? { previousWorkspaceIdentity } : {}),
    };
  }

  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of routesBySessionId.values()) {
      if (
        !route.mobileOnly &&
        !(route.firstRendererAttach && !route.connectFinalized) &&
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable"
      ) {
        void attachRendererPort(win, route, reason).catch((error: unknown) => {
          options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  function getRemoteConnectionStats(): RemoteConnectionStats {
    const activeRoutes = Array.from(routesBySessionId.values()).filter(
      (route) =>
        route.remoteUsageTelemetryEligible &&
        route.attachmentState === "attachable" &&
        route.connectFinalized,
    );
    return {
      activeSessionCount: activeRoutes.length,
      activeTargetCount: new Set(
        activeRoutes.map((route) => buildRemoteTargetTelemetryKey(route.descriptor.target)),
      ).size,
    };
  }

  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = routesBySessionId.get(sessionId);
    if (!route) return;
    retireActiveRoute(route, "disposed", () => {
      routesBySessionId.delete(sessionId);
    });
    route.providerProvisioningDispose?.();
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, "session-disposed");
      pending.reject(new Error(`远程 workspace session 已释放，sessionId=${sessionId}`));
    }
    if (!child) return;
    if (route.rendererAttachmentId) {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: route.rendererAttachmentId,
      });
    }
    child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    for (const [key, pending] of pendingProjectNavigations) {
      if (pending.win.webContents.id !== webContentsId) continue;
      pendingProjectNavigations.delete(key);
      pending.reject(new Error("窗口已关闭，项目导航已取消"));
    }

    for (const [sessionId, route] of Array.from(routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      retireActiveRoute(route, "window-closed", () => {
        routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (route.pendingRendererAttachment) {
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(new Error("窗口已关闭，attachment 已取消"));
      }
    }
    for (const [key, pending] of Array.from(pendingByRequestKey)) {
      if (pending.webContentsId !== webContentsId) continue;
      pendingByRequestKey.delete(key);
      pending.reject(new Error("窗口已关闭，远程连接已取消"));
    }
    for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
      if (!key.startsWith(`${webContentsId}\0`)) continue;
      pendingWorkspaceBindsByRequestKey.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error("窗口已关闭，workspace bind 已取消"));
    }
  }

  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const child = options.windowHostProcessMap.get(webContentsId);
    if (!child) return;
    for (const [key, pending] of pendingProjectNavigations) {
      if (
        pending.win.webContents.id !== webContentsId ||
        (requestId && pending.requestId !== requestId)
      )
        continue;
      pendingProjectNavigations.delete(key);
      child.postMessage({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: pending.requestId,
      });
      pending.reject(new Error("项目导航已取消"));
    }
    for (const pending of pendingByRequestKey.values()) {
      if (
        pending.webContentsId === webContentsId &&
        (!requestId || pending.requestId === requestId)
      ) {
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceConnect,
          requestId: pending.requestId,
        });
      }
    }
  }

  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      throw Object.assign(
        new Error(`未找到远程 workspace session，sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    if (route.attachmentState !== "attachable") {
      throw Object.assign(new Error("远程 workspace source 当前离线"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    const win = BrowserWindow.fromId(params.windowId);
    if (!win || win.webContents.id !== route.webContentsId) {
      throw Object.assign(new Error("远程 workspace session 不属于当前窗口"), {
        code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
      });
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(new Error("远程 workspaceKey 与 logical session 不匹配。"), {
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
      });
    }
    const process = getWindowHost(win);
    const { port1, port2 } = createMessageChannel();
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: params.clientMode,
        scope: {
          kind: "remote",
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      },
      [port2],
    );
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  function prepareProjectWorkspace(
    win: BrowserWindow,
    request: HostProjectWorkspaceNavigationInput,
    requestId: string = randomUUID(),
  ): Promise<HostPreparedProjectWorkspace> {
    if (appShutdownStarted || win.isDestroyed() || win.webContents.isDestroyed())
      return Promise.reject(new Error("窗口已关闭，项目导航已取消"));
    const child = getWindowHost(win);
    const key = requestKey(win.webContents.id, requestId);
    if (pendingProjectNavigations.has(key))
      return Promise.reject(new Error("项目导航 requestId 重复"));
    return new Promise((resolve, reject) => {
      pendingProjectNavigations.set(key, { child, win, requestId, resolve, reject });
      try {
        child.postMessage({
          type: HostMessageTypes.PrepareProjectWorkspace,
          requestId,
          ...request,
          clientMode: "web-remote-replayable",
        });
      } catch (error) {
        pendingProjectNavigations.delete(key);
        reject(error);
      }
    });
  }

  return {
    prepareProjectWorkspace,
    createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost,
    bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget,
    getRemoteConnectionStats,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    disposeAllAndWaitForAppShutdown: async (_reason: string) => {
      appShutdownStarted = true;
      const error = new Error("应用正在退出，远程连接已取消");
      for (const pending of pendingProjectNavigations.values()) pending.reject(error);
      pendingProjectNavigations.clear();
      for (const pending of pendingByRequestKey.values()) pending.reject(error);
      pendingByRequestKey.clear();
      for (const pending of pendingWorkspaceBindsByRequestKey.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingWorkspaceBindsByRequestKey.clear();
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        retireActiveRoute(route, "app-shutdown", () => {
          routesBySessionId.delete(sessionId);
        });
        route.providerProvisioningDispose?.();
        if (!route.pendingRendererAttachment) continue;
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(error);
      }
      routesBySessionId.clear();
    },
    cancelPendingRemoteWorkspaceSessionsForWindow,
    handleWorkspaceRunningTaskCountChanged: () => {
      // Running-task 事实现在由窗口 Host registry/ControllerProjection 持有；Main 不再维护 WSL pool。
    },
  };
}
