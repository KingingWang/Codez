import {
  createWebRemoteControlE2eeSession,
  decodeWebRemoteControlGzipEnvelopeAsync,
  WebRemoteControlRelayPayloadSerializer,
} from "@codez/client";
import {
  WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1,
  WEB_REMOTE_CONTROL_E2EE_HANDSHAKE_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  normalizeWebRemoteControlWirePayload,
  parseWebRemoteControlAppPayload,
  parseWebRemoteControlE2eeWirePayload,
  parseWebRemoteControlGzipEnvelope,
  type WebRemoteControlE2eeWirePayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailure,
} from "@codez/shared";
import {
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@codez/shared/web-remote-relay";

export async function readWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength <=
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
      ? data
      : null;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data as Uint8Array);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return data.text();
  }
  const text = String(data);
  return new TextEncoder().encode(text).byteLength <=
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ? text
    : null;
}

export function webSocketDataByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return new TextEncoder().encode(String(data)).byteLength;
}

export async function parseRelayMessage(
  data: unknown,
): Promise<WebRemoteControlRelayV2IncomingMessage | null> {
  try {
    const text = await readWebSocketData(data);
    if (text === null) return null;
    return parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createFailure(
  reason: WebRemoteControlFailure["reason"],
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

export function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    zcode_type: typeof record.zcode_type === "string" ? record.zcode_type : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    bridgeSessionId:
      typeof record.bridgeSessionId === "string" ? record.bridgeSessionId : undefined,
  };
}

export function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

export function summarizeRelayMessageForTrace(
  message:
    | WebRemoteControlRelayV2IncomingMessage
    | WebRemoteControlRelayV2OutgoingMessage
    | { type: "data"; payload: unknown },
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type };
  }
  if (message.type === "data") {
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}

/** 浏览器原生 gzip 解码（Safari 16.4+）；调用方必须先做能力检测再宣告。 */
export async function gunzipWithDecompressionStream(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export function buildClientCapabilitiesPayload() {
  const caps: string[] = [];
  if (typeof DecompressionStream === "function") {
    caps.push(WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1);
  }
  return {
    zcode_type: "client-capabilities" as const,
    v: 1 as const,
    caps,
  };
}

export async function unwrapInboundWebRemoteControlPayload(params: {
  payload: unknown;
  deviceSid: string;
  e2eeKey?: string;
  e2ee?: ReturnType<typeof createWebRemoteControlE2eeSession>;
  onRekey(): void;
  onReady(serializer: WebRemoteControlRelayPayloadSerializer): void;
}): Promise<{ kind: "handled" } | { kind: "payload"; payload: unknown }> {
  let payload = params.payload;
  if (params.e2eeKey) {
    const wire = parseWebRemoteControlE2eeWirePayload(payload);
    if (wire?.zcode_type === "e2ee-rekey" && wire.sid === params.deviceSid) {
      params.onRekey();
      return { kind: "handled" };
    }
    const result = params.e2ee?.accept(payload);
    if (!result) throw new Error("e2ee.unexpectedPayload");
    if (result.kind === "ready") {
      const session = params.e2ee!;
      params.onReady(
        new WebRemoteControlRelayPayloadSerializer({
          seal: (wirePayload) => session.prepare(wirePayload),
        }),
      );
      return { kind: "handled" };
    }
    if (result.kind !== "payload" && result.kind !== "duplicate-rpc") {
      return { kind: "handled" };
    }
    payload = result.payload;
  }
  payload = normalizeWebRemoteControlWirePayload(payload);
  const gzipEnvelope = parseWebRemoteControlGzipEnvelope(payload);
  if (gzipEnvelope) {
    const inner = await decodeWebRemoteControlGzipEnvelopeAsync(
      gzipEnvelope,
      gunzipWithDecompressionStream,
    );
    if (inner === null) return { kind: "handled" };
    payload = normalizeWebRemoteControlWirePayload(inner);
  }
  return { kind: "payload", payload };
}

/** 只适配入站消息；socket、配对与恢复事实始终由 transport 的当前状态端口提供。 */
export async function handleTerminalDataPayload(params: {
  payload: unknown;
  e2ee: TerminalE2eeController;
  rawOnly: boolean;
  isCurrent(): boolean;
  isPaired(): boolean;
  canContinueRetainedRpc(): boolean;
  onRawTransportPayload?(payload: unknown): boolean;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRekey(): void;
  onReady(): void;
  onFailure(error: Error): void;
}): Promise<void> {
  if (params.rawOnly) {
    if (params.e2ee.hasKey) {
      if (parseWebRemoteControlE2eeWirePayload(params.payload)?.zcode_type !== "e2ee-record")
        return;
    } else if (!isRawTransportCandidate(params.payload)) return;
  }
  let unwrapped: Awaited<ReturnType<TerminalE2eeController["unwrapInbound"]>>;
  try {
    unwrapped = await params.e2ee.unwrapInbound(params.payload, {
      onRekey: params.onRekey,
      onReady: params.onReady,
    });
  } catch (error) {
    if (!params.isCurrent()) return;
    if (
      error instanceof Error &&
      (error.message === "e2ee.staleEpoch" || error.message === "e2ee.staleRecord")
    )
      return;
    params.onFailure(error instanceof Error ? error : new Error("e2ee.authenticationFailed"));
    return;
  }
  if (unwrapped.kind === "handled" || !params.isCurrent()) return;
  // gzip 解码含 await；期间可能挂起、waiting、换 socket 或 dispose，旧结果不得重新
  // 开放普通业务入口。原连接的可靠帧仅交既有 adapter 校验/补 ACK，不回落 app payload。
  const payload = unwrapped.payload;
  if (params.rawOnly || !params.isPaired()) {
    if (
      (params.isPaired() || params.canContinueRetainedRpc()) &&
      params.e2ee.isReady() &&
      isRawTransportCandidate(payload)
    )
      params.onRawTransportPayload?.(payload);
    return;
  }
  if (isRawTransportCandidate(payload) && params.onRawTransportPayload?.(payload)) return;
  const parsed = parseWebRemoteControlAppPayload(payload);
  if (parsed) params.onPayload(parsed);
}

export function resolveTerminalReconnectJitterMs(options: {
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  reconnectJitterMs?: number;
}): number {
  const baseIntervalMs = options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS;
  const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
    baseIntervalMs,
    options.heartbeatJitterMs,
  );
  return getWebRemoteControlReconnectJitterMs(
    options.reconnectJitterMs ??
      Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
  );
}

export class TerminalE2eeController {
  serializer = new WebRemoteControlRelayPayloadSerializer();
  private session?: ReturnType<typeof createWebRemoteControlE2eeSession>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      deviceSid: string;
      e2eeKey?: string;
      handshakeTimeoutMs?: number;
      sendControl(payload: WebRemoteControlE2eeWirePayload): void;
      onFailure(error: Error): void;
      onReset?(): void;
    },
  ) {}

  get hasKey(): boolean {
    return Boolean(this.options.e2eeKey);
  }

  get isActive(): boolean {
    return Boolean(this.session);
  }

  isReady(): boolean {
    return !this.options.e2eeKey || Boolean(this.session?.isReady());
  }

  startSession(): void {
    if (!this.options.e2eeKey) return;
    this.session = createWebRemoteControlE2eeSession({
      role: "terminal",
      deviceSid: this.options.deviceSid,
      pairingKey: this.options.e2eeKey,
      send: (payload) => this.options.sendControl(payload),
    });
    this.session.start();
    this.clearDeadline();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      if (!this.session?.isReady()) {
        this.options.onFailure(new Error("e2ee.handshakeTimeout"));
      }
    }, this.options.handshakeTimeoutMs ?? WEB_REMOTE_CONTROL_E2EE_HANDSHAKE_TIMEOUT_MS);
  }

  clearDeadline(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  reset(): void {
    this.clearDeadline();
    if (!this.session) return;
    this.session.dispose();
    this.session = undefined;
    this.serializer = new WebRemoteControlRelayPayloadSerializer();
    this.options.onReset?.();
  }

  unwrapInbound(
    payload: unknown,
    callbacks: {
      onRekey(): void;
      onReady(): void;
    },
  ) {
    return unwrapInboundWebRemoteControlPayload({
      payload,
      deviceSid: this.options.deviceSid,
      e2eeKey: this.options.e2eeKey,
      e2ee: this.session,
      onRekey: () => {
        if (this.session?.isReady() && this.options.e2eeKey) {
          this.reset();
          callbacks.onRekey();
        }
      },
      onReady: (serializer) => {
        this.serializer = serializer;
        this.clearDeadline();
        callbacks.onReady();
      },
    });
  }
}
