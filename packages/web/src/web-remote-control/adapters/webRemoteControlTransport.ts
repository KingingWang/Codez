import type {
  WebRemoteControlTerminalTransportState,
  WebRemoteControlTerminalTransportDiagnostic,
  WebRemoteControlTerminalTransportDiagnosticInput,
  WebRemoteControlTerminalTransportOptions,
} from "#src/web-remote-control/contracts/transport.js";
import { createInitialPairingDeadline } from "#src/web-remote-control/adapters/initialPairingDeadline.js";
import {
  webSocketDataByteLength,
  parseRelayMessage,
  createFailure,
  handleTerminalDataPayload,
  summarizeRelayMessageForTrace,
  buildClientCapabilitiesPayload,
  resolveTerminalReconnectJitterMs,
  TerminalE2eeController,
} from "#src/web-remote-control/adapters/relayMessage.js";
import type { WebRemoteControlPayloadSendResult } from "@codez/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlE2eeWirePayload,
  type WebRemoteControlFailure,
} from "@codez/shared";
import {
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
  WebRemoteControlV2ConnectionError,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
  WEB_REMOTE_CONTROL_V2_RECONNECT_SPREAD_MS,
  webRemoteControlV2PairState,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@codez/shared/web-remote-relay";

export class WebRemoteControlTerminalTransport {
  private readonly WebSocketCtor: typeof globalThis.WebSocket;
  private socket?: WebSocket;
  private state: WebRemoteControlTerminalTransportState = "idle";
  private intentionallyClosed = false;
  private wasPaired = false;
  private hadPairedSession = false;
  // 打散窗口与电脑共用，受桌面 3 秒手机断连宽限约束；规则见 WebRemoteControlV2RetryPolicy.nextDelay。
  private readonly retry = new WebRemoteControlV2RetryPolicy(Math.random, {
    initialMs: 500,
    maxMs: 10_000,
    jitter: 0.2,
    spreadMs: WEB_REMOTE_CONTROL_V2_RECONNECT_SPREAD_MS,
  });
  private tokenController?: AbortController;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private authenticated = false;
  // 最近一次 matched 所在且尚未被 waiting/INTERNAL/关闭撤销的 socket；挂起不撤销这项连接事实。
  private pairedSocket?: WebSocket;
  private readonly heartbeat: WebRemoteControlV2Heartbeat;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private lastPairStatusAckAt = 0;
  private hiddenStartedAt?: number;
  private lastPairStatusDiagnostic?: string;
  private pairedWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly initialPairingDeadline: ReturnType<typeof createInitialPairingDeadline>;
  private desktopOfflineFailureTimer?: ReturnType<typeof setTimeout>;
  private readonly traceRelayMessages = import.meta.env.DEV;
  private readonly e2ee: TerminalE2eeController;
  private ingressChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: WebRemoteControlTerminalTransportOptions) {
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    this.initialPairingDeadline = createInitialPairingDeadline(
      options.initialConnectionTimeoutMs,
      () => {
        if (this.intentionallyClosed || this.state === "suspended") return;
        // Bug 原因：扩展静态桥不可用时会永久循环第 1 步；超时只结束尚未配对的首次连接。
        this.enterTerminalFailure(createFailure("relay-unavailable", "relay.initialConnectionTimedOut"));
      },
    );
    this.e2ee = new TerminalE2eeController({
      deviceSid: options.deviceSid,
      e2eeKey: options.e2eeKey,
      handshakeTimeoutMs: options.e2eeHandshakeTimeoutMs,
      sendControl: (payload) => this.sendE2eeControl(payload),
      onFailure: (error) => this.recoverFromE2eeFailure(error),
      onReset: () => options.onE2eeReset?.(),
    });
    this.heartbeat = new WebRemoteControlV2Heartbeat(
      () => this.sendPairStatusQuery(),
      () => this.reconnectAfterStaleWaiting(resolveTerminalReconnectJitterMs(this.options)),
      {
        intervalMs: options.heartbeatIntervalMs,
        jitterMs: options.heartbeatJitterMs,
        ackTimeoutMs: options.heartbeatAckTimeoutMs,
      },
    );
  }

  start(): void {
    this.intentionallyClosed = false;
    this.wasPaired = false;
    this.hadPairedSession = false;
    this.initialPairingDeadline.reset();
    this.staleWaitingCount = 0;
    this.retry.acknowledged();
    this.lastPairedSocketGeneration = 0;
    this.lastPairStatusAckAt = Date.now();
    this.setState("connecting");
    this.initialPairingDeadline.arm();
    this.connect();
  }

  private async handleIngressMessage(data: unknown, socket: WebSocket): Promise<void> {
    if (this.intentionallyClosed) return;
    try {
      await this.handleMessage(data, socket);
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async connect(): Promise<void> {
    if (this.intentionallyClosed || this.state === "suspended") return;
    const generation = ++this.socketGeneration;
    this.tokenController?.abort();
    const controller = new AbortController();
    this.tokenController = controller;
    this.authenticated = false;
    try {
      const token = await this.options.getToken(controller.signal);
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      const url = new URL(this.options.relayWsUrl);
      url.searchParams.set("token", token);
      if (this.options.deviceMid?.trim()) {
        url.searchParams.set("mid", this.options.deviceMid);
      }
      const socket = new this.WebSocketCtor(url.toString());
      this.socket = socket;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = setTimeout(
        () => this.scheduleReconnect(),
        this.options.socketHandshakeTimeoutMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
      );

      socket.addEventListener("open", () => {
        if (socket !== this.socket) return;
        const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
        // Bugfix: 手机端运行在浏览器 WebSocket API 下，无法主动传 perMessageDeflate 配置。
        // 只能通过标准 extensions 字段确认 relay 是否真的完成压缩协商，避免误以为业务代码可强制开启。
        this.emitDiagnostic({
          type: "socket-extensions",
          state: this.state,
          perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
          ...(negotiatedExtensions ? { extensions: negotiatedExtensions } : {}),
        });
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          device_sid: this.options.deviceSid,
          meta: {
            platform: "web",
            version: this.options.appVersion ?? "web",
            name: "mobile-browser",
          },
          client_ts: Math.floor(Date.now() / 1000),
        });
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this.socket) return;
        const data = event.data;
        this.ingressChain = this.ingressChain.then(
          () => this.handleIngressMessage(data, socket),
          () => this.handleIngressMessage(data, socket),
        );
      });

      socket.addEventListener("error", () => {
        if (socket !== this.socket) return;
        this.emitDiagnostic({ type: "socket-error", state: this.state });
        this.options.onError(new Error("External relay terminal socket error"));
      });

      socket.addEventListener("close", (event) => {
        if (socket !== this.socket) return;
        this.emitDiagnostic({
          type: "socket-close",
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          wasPaired: this.wasPaired,
          state: this.state,
        });
        this.stopHeartbeat();
        this.e2ee.reset();
        this.clearWaitingTimer();
        if (this.intentionallyClosed || this.state === "suspended") return;
        // Bugfix: 手机浏览器后台恢复、网络切换或 relay 短抖会关闭已配对 socket。
        // 旧逻辑直接刷新整页，导致用户丢失当前 workspace/task 视图；这里改为原地重连，
        // 让上层在重新 paired 后按 mobile view state 恢复。
        this.scheduleReconnect();
      });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      if (error instanceof WebRemoteControlV2ConnectionError && !error.retryable) {
        this.enterTerminalFailure(
          createFailure(
            error.reason,
            // Bug 原因：扩展 HTTP 桥失联原先被压成普通 relay-unavailable，用户只看到首屏重连。
            // 仅放行本地固定诊断码，不把服务器正文、JWT 或一次性 token 带到错误页。
            error.message === "extension-http-bridge-unavailable" ? error.message : undefined,
          ),
        );
      } else this.scheduleReconnect();
    }
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    if (!this.e2ee.isReady()) {
      throw new Error("e2ee.notReady");
    }
    return this.e2ee.serializer.prepare(payload, Math.floor(Date.now() / 1000)).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    if (!this.e2ee.isReady()) {
      return { kind: "unavailable" };
    }
    const prepared = this.e2ee.serializer.prepare(payload, Math.floor(Date.now() / 1000));
    if (this.e2ee.serializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    // 挂起期间只确认已收到的可靠帧，避免对端 45 秒期限误判；新的业务发送仍等 paired。
    const retainedAck = payload.zcode_type === "rpc-frame-ack" && this.canContinueRetainedRpc();
    if (this.state !== "paired" && !retainedAck) {
      return { kind: "unavailable" };
    }
    return this.sendSerialized(prepared.message, prepared.json)
      ? { kind: "sent", bytes: prepared.bytes }
      : { kind: "unavailable" };
  }

  suspend(): void {
    if (
      this.state !== "paired" &&
      this.state !== "securing" &&
      this.state !== "connecting" &&
      this.state !== "reconnecting" &&
      this.state !== "authenticating" &&
      this.state !== "waiting"
    ) {
      return;
    }
    // 未认证连接没有可复用的会话，挂起时撤销它；迟到 open/ACK 不能在后台启动 bootstrap。
    if (!this.authenticated) this.closeSocket();
    this.hiddenStartedAt = Date.now();
    this.tokenController?.abort();
    clearTimeout(this.handshakeTimer);
    this.initialPairingDeadline.pause();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.setState("suspended");
  }

  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    if (this.intentionallyClosed) throw new Error("Web remote control transport stopped.");
    this.initialPairingDeadline.arm();
    this.emitDiagnostic({ type: "recover-start", state: this.state });
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    if (
      this.state === "suspended" &&
      this.wasPaired &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    ) {
      // Bugfix: hidden/pagehide 只说明手机页面暂停过，不代表 WebSocket 一定坏了。
      // 先用原 socket 做一次 pair_status 探测，避免短暂切后台也强制断开重连。
      this.setState("reconnecting");
      if (this.sendPairStatusQuery()) {
        try {
          await this.waitForPaired(this.options.healthCheckTimeoutMs ?? 3_000);
          return;
        } catch {
          // 探测超时后再重建 socket；这里不直接失败，避免把短暂恢复慢误判为桌面断开。
        }
      }
    }
    this.retry.reset();
    this.reconnectNow();
    await this.waitForPaired(timeoutMs);
  }

  recoverInBackground(): void {
    if (this.intentionallyClosed || this.state === "paired" || this.state === "kicked") {
      return;
    }
    // Bugfix: 手机端长时间后台恢复可能超过 recoverConnection 的单次等待窗口。
    // 这里继续原地重连，不把当前页面切成错误页，保证用户正在输入的草稿不被卸载。
    this.clearReconnectTimer();
    this.clearWaitingTimer();
    this.clearDesktopOfflineFailureTimer();
    this.stopHeartbeat();
    this.staleWaitingCount = 0;
    this.initialPairingDeadline.arm();
    this.reconnectNow();
  }

  dispose(): void {
    this.intentionallyClosed = true;
    this.e2ee.reset();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.initialPairingDeadline.complete();
    this.rejectPairedWaiters(new Error("Web remote control transport disposed."));
    this.closeSocket();
    this.setState("idle");
  }

  private async handleMessage(data: unknown, socket: WebSocket): Promise<void> {
    if (
      webSocketDataByteLength(data) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
      return;
    }
    const message = await parseRelayMessage(data);
    if (!message || socket !== this.socket || this.intentionallyClosed) {
      return;
    }
    this.logRelayTrace("recv", summarizeRelayMessageForTrace(message));

    switch (message.type) {
      case "auth_ack":
        if (this.state !== "authenticating" || message.device_sid !== this.options.deviceSid)
          return;
        this.authenticated = true;
        clearTimeout(this.handshakeTimer);
        this.retry.acknowledged();
        this.applyPairStatus(message.pair_status);
        break;
      case "pair_status_ack":
        if (!this.authenticated) return;
        if (this.state === "suspended") {
          // 后台 waiting 只撤销 raw 帧许可；迟到 matched 不复活页面或心跳，回前台由探测重新确认。
          if (message.pair_status === "waiting") this.pairedSocket = undefined;
          return;
        }
        this.applyPairStatus(message.pair_status);
        break;
      case "data":
        if (!this.authenticated) return;
        if (this.state === "paired" || this.state === "securing") {
          await this.handleDataPayload(message.payload, socket);
        } else if (this.canContinueRetainedRpc() && this.e2ee.isReady()) {
          // 挂起期间密文必须先鉴权解密，再判定 raw 帧；不能绕过 E2EE，也不能让握手控制
          // 在后台触发 paired/ready。已撤销许可或未完成握手的连接仍不进入恢复 adapter。
          await this.handleDataPayload(message.payload, socket, true);
        }
        break;
      case "error":
        this.handleRelayError(message.code, message.message);
        break;
    }
  }

  /** 挂起或原 socket 探测期间，当前 socket 是否仍是已认证、打开的同一连接；默认还要求 raw 帧许可未撤销。 */
  private canContinueRetainedRpc(requirePermit = true): boolean {
    return (
      (this.state === "suspended" || this.state === "reconnecting") &&
      this.authenticated &&
      (!requirePermit || this.socket === this.pairedSocket) &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    );
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    this.pairedSocket = status === "matched" ? this.socket : undefined;
    this.lastPairStatusAckAt = Date.now();
    this.emitDiagnostic({ type: "pair-status", pairStatus: status, state: this.state });
    if (webRemoteControlV2PairState(status) === "waiting_terminal") {
      this.e2ee.reset();
      if (this.wasPaired) {
        // Bugfix: codez-remote-hub 的 waiting 是合法配对状态，表示当前 device 不在 hub 里，
        // 不是 terminal WS 损坏信号。已配对后降级为 waiting 时保持同一条手机端 WS，
        // 继续轻量查询，避免把桌面端短暂重连放大成手机端反复踢旧连接。
        this.staleWaitingCount = 0;
        this.clearReconnectTimer();
        this.clearWaitingTimer();
        this.clearDesktopOfflineFailureTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.setState("waiting");
      this.startHeartbeat();
      this.startWaitingTimer();
      return;
    }
    if (status === "matched") {
      const previousPairedGeneration = this.lastPairedSocketGeneration;
      const sendReadyKind =
        previousPairedGeneration === 0
          ? null
          : previousPairedGeneration === this.socketGeneration
            ? "same-socket"
            : "reconnected-socket";
      this.retry.acknowledged();
      this.clearDesktopOfflineFailureTimer();
      this.clearReconnectTimer();
      this.clearWaitingTimer();
      if (this.e2ee.hasKey) {
        if (!this.e2ee.isActive) {
          this.setState("securing");
          this.e2ee.startSession();
        } else if (this.e2ee.isReady()) {
          this.setState("paired");
        }
        this.wasPaired = true;
        this.hadPairedSession = true;
        this.lastPairedSocketGeneration = this.socketGeneration;
        this.startHeartbeat();
        if (this.e2ee.isReady() && sendReadyKind) {
          this.options.onSendReady?.({ kind: sendReadyKind });
        }
        return;
      }
      this.setState("paired");
      this.wasPaired = true;
      this.hadPairedSession = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message?: string,
  ): void {
    if (code === "KICKED") {
      const delay = this.retry.kickedDelay();
      if (delay === null) this.enterTerminalFailure(createFailure("session-conflict"));
      else this.scheduleReconnect({ delayMs: delay });
      return;
    }
    if (code === "DEVICE_OFFLINE") {
      // Bugfix: 桌面端打开远控或 relay 短暂重连时，手机可能先收到一次 DEVICE_OFFLINE。
      // 旧逻辑会立刻渲染“电脑端离线”终态页，实际桌面 1~2 秒后就恢复 paired。
      // 这里先进入可恢复重连窗口，超过宽限时间仍未 paired 才认定桌面真正离线。
      this.recoverFromDeviceOffline(message || code);
      return;
    }
    if (code === "AUTH_FAILED" || code === "WRONG_PARAM") {
      this.enterTerminalFailure(
        createFailure(code === "AUTH_FAILED" ? "device-not-owned" : "invalid-mobile-connection"),
      );
      return;
    }
    if (code === "INTERNAL") {
      if (this.wasPaired && this.canContinueRetainedRpc(false)) {
        // Bugfix: 挂起期间回 ACK 时 hub 找不到桌面只回 INTERNAL。若按未配对重连处理，会关闭 socket
        // 并清掉 wasPaired，回前台跳过原 socket 探测，桌面未回来时 30 秒进入失败页。这里只撤销许可。
        // 多个 ACK 在途时会连收 INTERNAL，首个已撤销许可，所以这里不要求许可，否则后续落回未配对分支。
        this.pairedSocket = undefined;
        this.options.onError(new Error(message || code));
        return;
      }
      if (this.state === "paired" || (this.hadPairedSession && this.state === "waiting")) {
        this.enterWaitingForDeviceAfterRelayError(message || code);
        return;
      }
      // Bugfix: relay 在桌面/手机快速重连切换时会短暂回 INTERNAL。
      // 这类错误大多可恢复，直接抛失败页会迫使用户手动重开远控；改为原地重连恢复。
      this.recoverFromRelayInternal(message || code);
      return;
    }
    this.enterTerminalFailure(createFailure("relay-unavailable", message || code));
  }

  private handleDataPayload(payload: unknown, socket: WebSocket, rawOnly = false): Promise<void> {
    return handleTerminalDataPayload({
      payload,
      e2ee: this.e2ee,
      rawOnly,
      isCurrent: () => socket === this.socket && !this.intentionallyClosed && this.authenticated,
      isPaired: () => this.state === "paired",
      canContinueRetainedRpc: () => this.canContinueRetainedRpc(),
      onRawTransportPayload: (frame) => this.options.onRawTransportPayload?.(frame) ?? false,
      onPayload: (message) => this.options.onPayload(message),
      onRekey: () => {
        this.setState("securing");
        this.e2ee.startSession();
      },
      onReady: () => {
        const prepared = this.e2ee.serializer.prepare(buildClientCapabilitiesPayload());
        void this.sendSerialized(prepared.message, prepared.json);
        this.setState("paired");
        this.startHeartbeat();
        this.options.onSendReady?.({ kind: "reconnected-socket" });
      },
      onFailure: (error) => this.recoverFromE2eeFailure(error),
    });
  }

  private sendE2eeControl(payload: WebRemoteControlE2eeWirePayload): void {
    const prepared = this.e2ee.serializer.prepareControl(payload);
    if (
      this.e2ee.serializer.isOversize(prepared) ||
      !this.sendSerialized(prepared.message, prepared.json)
    ) {
      this.recoverFromE2eeFailure(new Error("e2ee.handshakeSendFailed"));
    }
  }

  private recoverFromE2eeFailure(error: Error): void {
    this.e2ee.reset();
    this.recoverFromRelayInternal(error.message);
  }

  private startHeartbeat(): void {
    this.heartbeat.acknowledged();
  }

  private sendPairStatusQuery(): boolean {
    return this.send({
      type: "pair_status_query",
      client_ts: Math.floor(Date.now() / 1000),
    });
  }

  private stopHeartbeat(): void {
    this.heartbeat.stop();
  }

  private startWaitingTimer(): void {
    if (this.waitingTimer) return;
    this.waitingTimer = setTimeout(() => {
      if (this.state !== "waiting") return;
      this.enterTerminalFailure(
        createFailure(
          "desktop-disconnected",
          "Desktop did not match this mobile connection before the waiting timeout.",
        ),
      );
    }, this.options.waitingTimeoutMs ?? 30_000);
  }

  private clearWaitingTimer(): void {
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearReconnectTimer();
    // Bugfix: 已配对手机在恢复时可能先拿到 auth_ack: waiting。
    // 这里不能清掉 wasPaired，否则下一跳 waiting 会被当成首次未匹配并进入失败页；
    // 保留已配对语义，让状态机继续按可恢复短断连重试到 matched。
    if (reconnectDelayMs > 0) {
      this.closeSocket();
      this.setState("reconnecting");
      this.lastPairStatusAckAt = Date.now();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionallyClosed || this.state === "suspended") {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    this.closeSocket();
    this.setState("reconnecting");
    this.lastPairStatusAckAt = Date.now();
    this.connect();
  }

  private scheduleReconnect(options?: { delayMs?: number }): void {
    if (this.intentionallyClosed || this.state === "suspended" || this.reconnectTimer) return;
    // Bugfix: 原来 INTERNAL/DEVICE_OFFLINE 为 0ms 重连、心跳超时为 0~1秒，relay 批量下发错误时多台手机
    // 同时申请 token。现统一走 retry.nextDelay()，连接建立后的第1次重连在打散窗口内随机。
    const delayMs = options?.delayMs ?? this.retry.nextDelay();
    this.closeSocket();
    this.setState("reconnecting");
    this.emitDiagnostic({ type: "recover-scheduled", state: this.state });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed || this.state === "suspended") {
        return;
      }
      this.wasPaired = false;
      this.closeSocket();
      this.connect();
    }, delayMs);
  }

  private recoverFromRelayInternal(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    this.closeSocket();
    this.scheduleReconnect();
  }

  private recoverFromDeviceOffline(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    if (!this.desktopOfflineFailureTimer) {
      this.desktopOfflineFailureTimer = setTimeout(() => {
        this.desktopOfflineFailureTimer = undefined;
        this.enterTerminalFailure(createFailure("desktop-disconnected", message));
      }, this.options.desktopOfflineGraceMs ?? 15_000);
    }
    this.closeSocket();
    this.scheduleReconnect();
  }

  private enterWaitingForDeviceAfterRelayError(message: string): void {
    this.pairedSocket = undefined;
    // Bugfix: codez-remote-hub 在已认证连接上转发 data 找不到 device 时只返回 INTERNAL，
    // 不会关闭当前 terminal WS。这里保持手机端 WS，降级为 waiting 并继续查询配对状态，
    // 避免把“桌面端暂时不在”放大成手机端反复重连。
    this.options.onError(new Error(message));
    this.clearWaitingTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState("waiting");
    this.startHeartbeat();
  }

  private clearDesktopOfflineFailureTimer(): void {
    if (this.desktopOfflineFailureTimer) clearTimeout(this.desktopOfflineFailureTimer);
    this.desktopOfflineFailureTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private waitForPaired(timeoutMs = 15_000): Promise<void> {
    if (this.state === "paired") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pairedWaiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.pairedWaiters.add(waiter);
    });
  }

  private resolvePairedWaiters(): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pairedWaiters.clear();
  }

  private rejectPairedWaiters(error: Error): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pairedWaiters.clear();
  }

  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    this.intentionallyClosed = true;
    this.initialPairingDeadline.complete();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState(failure.reason === "session-conflict" ? "kicked" : "error");
    this.rejectPairedWaiters(new Error(failure.message ?? failure.reason));
    this.options.onFailure(failure);
    this.closeSocket();
  }

  private closeSocket(): void {
    this.pairedSocket = undefined;
    // 等待超时属于旧 socket；KICKED 的退避不能让其残留引用阻止新一代重新计时。
    this.clearWaitingTimer();
    ++this.socketGeneration;
    this.tokenController?.abort();
    this.tokenController = undefined;
    this.authenticated = false;
    this.e2ee.reset();
    clearTimeout(this.handshakeTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private setState(state: WebRemoteControlTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({
      type: "state-transition",
      previousState,
      state,
    });
    this.options.onStateChange(state);
    if (state === "paired") {
      this.initialPairingDeadline.complete();
      this.resolvePairedWaiters();
    }
    if (state === "error" || state === "kicked") {
      this.rejectPairedWaiters(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  private send(message: WebRemoteControlRelayV2OutgoingMessage): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength >
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayV2OutgoingMessage | { type: "data"; payload: unknown },
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    this.logRelayTrace("send", summarizeRelayMessageForTrace(message));
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    // Bugfix: 远控 relay 消息量高，生产环境打印正文会快速放大日志体积并暴露敏感内容。
    // 这里只在开发态输出摘要字段，排查链路足够且不会污染线上日志。
    console.info("[web-remote-control][relay-message]", {
      direction,
      ...fields,
    });
  }

  private emitDiagnostic(diagnostic: WebRemoteControlTerminalTransportDiagnosticInput): void {
    if (diagnostic.type === "pair-status") {
      const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
      if (this.lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
        return;
      }
      this.lastPairStatusDiagnostic = nextPairStatusDiagnostic;
    }
    const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt && visibilityState !== "hidden"
        ? Date.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic?.({
      ...diagnostic,
      timestamp: Date.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic);
  }
}
