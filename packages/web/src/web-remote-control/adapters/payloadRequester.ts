import type { WebRemoteControlAppPayload, WebRemoteControlFailure } from "@codez/shared";
import { createFailure } from "#src/web-remote-control/adapters/relayMessage.js";

interface WebRemoteControlAppPayloadRequesterOptions {
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  timeoutMs?: number;
}

interface WebRemoteControlAppPayloadRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function createAbortFailure(): WebRemoteControlFailure {
  const error = new Error("Web remote control payload request was aborted.");
  error.name = "AbortError";
  return Object.assign(error, {
    reason: "unexpected-error",
  }) as WebRemoteControlFailure & Error;
}

interface PendingAppPayloadRequest<TResponse extends WebRemoteControlAppPayload> {
  isMatch(payload: WebRemoteControlAppPayload): payload is TResponse;
  resolve(payload: TResponse): void;
  reject(error: WebRemoteControlFailure): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface WebRemoteControlRelayRequestRecoveryOptions {
  recoverTimeout?: boolean;
  /** 默认 true；bridge-open 这类不可安全重放的请求必须显式禁用 generic 恢复。 */
  recoverUnavailable?: boolean;
}

function isRecoverableRelayRequestFailure(
  error: unknown,
  options?: WebRemoteControlRelayRequestRecoveryOptions,
): boolean {
  const failure = error as Partial<WebRemoteControlFailure> | undefined;
  return (
    (failure?.reason === "relay-unavailable" && options?.recoverUnavailable !== false) ||
    (options?.recoverTimeout === true && failure?.reason === "desktop-bootstrap-timeout")
  );
}

export function createWebRemoteControlRelayRequestRecovery(
  recoverConnection: (reason?: "relay-unavailable" | "desktop-bootstrap-timeout") => Promise<void>,
) {
  let recoveryPromise: Promise<void> | undefined;

  async function recoverRelayRequestPath(
    reason: "relay-unavailable" | "desktop-bootstrap-timeout",
  ): Promise<void> {
    if (!recoveryPromise) {
      // Bugfix: 多个请求同时撞上 relay suspect 窗口时必须共用一次恢复。
      // 否则每个请求都会触发 recoverConnection，容易把短暂抖动放大成连续重连。
      recoveryPromise = recoverConnection(reason).finally(() => {
        recoveryPromise = undefined;
      });
    }
    await recoveryPromise;
  }

  return async function requestWithRelayRecovery<T>(
    request: () => Promise<T>,
    options?: WebRemoteControlRelayRequestRecoveryOptions,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw error;
      if (!isRecoverableRelayRequestFailure(error, options)) {
        throw error;
      }
      await recoverRelayRequestPath(
        (error as Partial<WebRemoteControlFailure>).reason as
          | "relay-unavailable"
          | "desktop-bootstrap-timeout",
      );
      return request();
    }
  };
}

export function createWebRemoteControlAppPayloadRequester({
  sendPayload,
  timeoutMs: defaultTimeoutMs = 10_000,
}: WebRemoteControlAppPayloadRequesterOptions) {
  const pending = new Map<string, PendingAppPayloadRequest<WebRemoteControlAppPayload>>();

  function rejectRequest(requestId: string, failure: WebRemoteControlFailure): boolean {
    const request = pending.get(requestId);
    if (!request) {
      return false;
    }
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.onAbort as EventListener);
    pending.delete(requestId);
    request.reject(failure);
    return true;
  }

  return {
    requestAppPayload<TResponse extends WebRemoteControlAppPayload>(
      payload: WebRemoteControlAppPayload & { requestId: string },
      isMatch: (payload: WebRemoteControlAppPayload) => payload is TResponse,
      options?: WebRemoteControlAppPayloadRequestOptions,
    ): Promise<TResponse> {
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Web remote control payload request was aborted.", "AbortError"));
          return;
        }
        const onAbort = () => rejectRequest(payload.requestId, createAbortFailure());
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          pending.delete(payload.requestId);
          reject(createFailure("desktop-bootstrap-timeout", "Desktop did not respond in time."));
        }, options?.timeoutMs ?? defaultTimeoutMs);
        pending.set(payload.requestId, {
          isMatch,
          resolve: resolve as (payload: WebRemoteControlAppPayload) => void,
          reject,
          timer,
          signal,
          onAbort,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!sendPayload(payload)) {
          // Bugfix: 之前非 paired / suspect 状态下 sendPayload 会静默丢弃，
          // requester 仍等到超时并误报“桌面未响应”。这里立即按链路不可发送失败，
          // 让上层可以选择等待重连或重放幂等请求。
          clearTimeout(timer);
          pending.delete(payload.requestId);
          signal?.removeEventListener("abort", onAbort);
          reject(
            createFailure(
              "relay-unavailable",
              "Web remote control transport is not ready to send payload.",
            ),
          );
        }
      });
    },

    acceptPayload(payload: WebRemoteControlAppPayload): boolean {
      if (
        (payload.codez_type === "app-error" || payload.codez_type === "workspace-bridge-error") &&
        payload.requestId
      ) {
        // Bugfix: remote session 关闭这类异步 bridge error 会带合成 requestId，
        // 但它不是某个 pending request 的响应。只有真正命中 pending 时才消费，
        // 否则交给上层按 bridge 失效事件触发重连/降级 UI。
        return rejectRequest(payload.requestId, createFailure(payload.reason, payload.error));
      }

      for (const [requestId, request] of pending) {
        if (!request.isMatch(payload)) {
          continue;
        }
        clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort as EventListener);
        pending.delete(requestId);
        request.resolve(payload);
        return true;
      }
      return false;
    },

    get pendingCount(): number {
      return pending.size;
    },

    rejectAll(failure: WebRemoteControlFailure): void {
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort as EventListener);
        pending.delete(requestId);
        request.reject(failure);
      }
    },

    dispose(): void {
      this.rejectAll(createFailure("desktop-disconnected", "Web remote control transport closed."));
    },
  };
}
