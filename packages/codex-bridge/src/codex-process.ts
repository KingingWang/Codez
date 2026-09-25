import { spawn } from "node:child_process";
import type {
  CodexNotification,
  CodexProcess,
  CodexProcessOptions,
  CodexServerRequest,
} from "./contract.js";
import { CodexRpcError, CodexTransportError } from "./rpc-errors.js";
import {
  encodeFrame,
  frameEnvelopeHint,
  MAX_FRAME_BYTES,
  RpcFramer,
  validId,
  type CodexDroppedFrame,
  type RpcEnvelope,
  type RpcId,
} from "./rpc-framing.js";
import { shutdownCodex } from "./rpc-shutdown.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const MAX_PENDING = 1024;

/** Sole owner of one connection, its handshake, request correlation and process lifetime. */
export function createCodexProcess(options: CodexProcessOptions): CodexProcess {
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new CodexTransportError("INVALID", "Invalid Codex request timeout");
  }
  const interactionTimeout = options.interactionTimeoutMs;
  if (
    interactionTimeout !== undefined &&
    (!Number.isSafeInteger(interactionTimeout) ||
      interactionTimeout <= 0 ||
      interactionTimeout > 2_147_483_647)
  ) {
    throw new CodexTransportError("INVALID", "Invalid Codex interaction timeout");
  }
  const child = spawn(options.executable, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: "pipe",
  });
  const pending = new Map<RpcId, Pending>();
  const serverRequests = new Map<RpcId, ReturnType<typeof setTimeout> | undefined>();
  const writes = new Set<(error: Error) => void>();
  const notifications = new Set<(event: CodexNotification) => void>();
  const requests = new Set<(event: CodexServerRequest) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  const framer = new RpcFramer();
  let nextId = 0n;
  let ready = false;
  let terminal: Error | undefined;
  let initialization: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let resolveClosed: () => void;
  const childClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function notify<T>(listeners: Set<(event: T) => void>, event: T): void {
    const snapshot = [...listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // 调用方监听器异常不能破坏协议关联或阻止其他监听器；此处不记录敏感事件。
      }
    }
  }
  function finish(error: Error): void {
    if (terminal) return;
    terminal = error;
    ready = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const timer of serverRequests.values()) if (timer !== undefined) clearTimeout(timer);
    serverRequests.clear();
    for (const reject of writes) reject(error);
    notify(closeListeners, error);
    notifications.clear();
    requests.clear();
    closeListeners.clear();
  }
  function stop(error: Error): Promise<void> {
    finish(error);
    return (shutdown ??= shutdownCodex(child, childClosed));
  }
  function requireReady(): void {
    if (terminal) throw terminal;
    if (!ready) throw new CodexTransportError("NOT_READY", "Codex connection is not initialized");
  }
  function rejectPending(id: RpcId, error: Error): boolean {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(error);
    return true;
  }
  /**
   * 超大入站帧已被 framer 按 NDJSON 边界丢弃。这里只做显式归因失败：
   * 不重试、不伪造结果、不终止连接；无法证明归属时让全部在途请求显式失败，
   * 避免请求方永远等待一个已被丢弃的响应。
   */
  function handleDroppedFrame(frame: CodexDroppedFrame): void {
    const hint = frameEnvelopeHint(frame.prefix);
    const error = new CodexTransportError("LIMIT", "Codex response frame exceeds size limit");
    if (hint.method === undefined && hint.id === undefined) {
      // 前缀可能来自原生 server request；不知道 id 就无法安全应答，必须失败关闭。
      void stop(error);
    } else if (hint.method !== undefined) {
      if (hint.id !== undefined) {
        // 被丢弃的是原生 server request：它从未进入 receive 注册表，
        // 必须直接按 id 回错误，否则原生端会永远等待答复。
        void write({
          id: hint.id,
          error: { code: -32000, message: "Codex request frame exceeds size limit" },
        }).catch((writeError: Error) => void stop(writeError));
      }
      // 纯通知没有请求方可失败；诊断经 onFrameDropped 上报，投影不靠猜测补齐。
    } else if (hint.id === undefined || !rejectPending(hint.id, error)) {
      // 前缀里看不到归属 id：无法证明丢失的是哪个响应，全部在途请求显式失败。
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    }
    try {
      options.onFrameDropped?.(frame);
    } catch {
      // 诊断回调绝不能破坏传输状态机。
    }
  }
  function write(message: RpcEnvelope, serialized?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (terminal) {
        reject(terminal);
        return;
      }
      let encoded: string;
      try {
        encoded = serialized ?? encodeFrame(message);
      } catch (error) {
        reject(error);
        return;
      }
      if (
        writes.size >= MAX_PENDING ||
        child.stdin.writableLength + Buffer.byteLength(encoded) > MAX_FRAME_BYTES + 1
      ) {
        reject(new CodexTransportError("LIMIT", "Codex RPC write buffer limit reached"));
        return;
      }
      const complete = (error?: Error) => {
        clearTimeout(timer);
        writes.delete(abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = (error: Error) => complete(error);
      const timer = setTimeout(() => {
        void stop(
          new CodexTransportError("TIMEOUT", "Codex RPC write timed out; outcome is unknown"),
        );
      }, timeout);
      writes.add(abort);
      child.stdin.write(encoded, (error) => {
        if (error)
          void stop(new CodexTransportError("CLOSED", "Codex connection closed while writing"));
        else complete();
      });
    });
  }
  function request(method: string, params?: unknown): Promise<unknown> {
    if (pending.size >= MAX_PENDING)
      return Promise.reject(
        new CodexTransportError("LIMIT", "Codex pending request limit reached"),
      );
    // 超时请求可能已生效，ID 永不复用且不重试，避免迟到响应关联到后续变更。
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new CodexTransportError("TIMEOUT", "Codex RPC request timed out; outcome is unknown"),
        );
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      void write({ id, method, params }).catch((error: Error) => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(error);
      });
    });
  }
  function reply(id: RpcId, message: RpcEnvelope): Promise<void> {
    requireReady();
    if (!validId(id) || !serverRequests.has(id)) {
      throw new CodexTransportError("INVALID", "No pending Codex server request; reply is stale");
    }
    // 先验证序列化，再消费唯一回复权；写入失败后也不能重发有副作用的批准。
    const serialized = encodeFrame(message);
    const timer = serverRequests.get(id);
    if (timer !== undefined) clearTimeout(timer);
    serverRequests.delete(id);
    return write(message, serialized);
  }
  function receive(message: RpcEnvelope): boolean {
    if (terminal) return false;
    if (message.method !== undefined) {
      if (message.id === undefined) {
        // 原生可因取消/其他客户端答复而提前结束请求；同时撤销当前连接的回复权。
        if (
          message.method === "serverRequest/resolved" &&
          message.params &&
          typeof message.params === "object" &&
          "requestId" in message.params
        ) {
          const id = message.params.requestId;
          if (validId(id)) {
            const timer = serverRequests.get(id);
            if (timer !== undefined) clearTimeout(timer);
            serverRequests.delete(id);
          }
        }
        notify(notifications, { method: message.method, params: message.params });
      } else {
        const id = message.id;
        if (!ready || serverRequests.has(id) || serverRequests.size >= MAX_PENDING) {
          throw new CodexTransportError("PROTOCOL", "Invalid Codex server request protocol state");
        }
        if (!requests.size) {
          void write({ id, error: { code: -32601, message: "Unsupported server request" } }).catch(
            (error: Error) => stop(error),
          );
        } else {
          // 人工审批/提问可能等待数分钟，不能复用普通 RPC 的 30 秒超时。
          // 默认不设定时器，仍由 pending 上限和连接关闭回收；仅显式配置时才过期。
          serverRequests.set(
            id,
            interactionTimeout === undefined
              ? undefined
              : setTimeout(() => {
                  serverRequests.delete(id);
                  void write({
                    id,
                    error: { code: -32000, message: "Server request timed out" },
                  }).catch((error: Error) => stop(error));
                }, interactionTimeout),
          );
          notify(requests, { id, method: message.method, params: message.params });
        }
      }
    } else {
      const entry = pending.get(message.id!);
      if (entry) {
        pending.delete(message.id!);
        clearTimeout(entry.timer);
        if (message.error)
          entry.reject(new CodexRpcError(message.error.code, message.error.message));
        else entry.resolve(message.result);
      }
    }
    return !terminal;
  }

  child.on("error", () => {
    void stop(
      new CodexTransportError(
        "STARTUP",
        "Cannot start Codex executable; verify its path, permissions and working directory",
      ),
    );
  });
  child.stdin.on("error", () => {
    void stop(new CodexTransportError("CLOSED", "Codex stdin connection closed"));
  });
  child.stdout.on("error", () => {
    void stop(new CodexTransportError("CLOSED", "Codex stdout connection closed"));
  });
  child.stderr.on("error", () => {
    void stop(new CodexTransportError("CLOSED", "Codex stderr connection closed"));
  });
  child.stderr.resume(); // Drain without retaining or logging credentials/diagnostics.
  child.stdout.on("data", (chunk: Buffer) => {
    if (terminal) return;
    try {
      framer.push(chunk, receive, handleDroppedFrame);
    } catch (error) {
      void stop(error as Error);
    }
  });
  child.stdout.on("end", () => {
    if (terminal) return;
    try {
      framer.end();
    } catch (error) {
      void stop(error as Error);
      return;
    }
    void stop(new CodexTransportError("CLOSED", "Codex stdout connection closed"));
  });
  child.on("exit", (code, signal) => {
    finish(
      new CodexTransportError(
        "CLOSED",
        `Codex process closed (exit ${code ?? "none"}, signal ${signal ?? "none"})`,
      ),
    );
    shutdown ??= shutdownCodex(child, childClosed);
  });
  child.on("close", () => {
    resolveClosed();
    finish(new CodexTransportError("CLOSED", "Codex process closed"));
  });

  return {
    async initialize() {
      if (terminal) throw terminal;
      return (initialization ??= (async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "codez", title: "Codez", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          });
          await write({ method: "initialized" });
          if (terminal) throw terminal;
          ready = true;
        } catch (error) {
          void stop(error as Error);
          throw error;
        }
      })());
    },
    async request<T>(method: string, params?: unknown): Promise<T> {
      requireReady();
      if (
        !method ||
        typeof method !== "string" ||
        method === "initialize" ||
        method === "initialized"
      ) {
        throw new CodexTransportError("INVALID", "Invalid or reserved handshake method");
      }
      return request(method, params) as Promise<T>;
    },
    async respond(id, result) {
      await reply(id, { id, result: result === undefined ? null : result });
    },
    async respondError(id, error) {
      if (!error || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
        throw new CodexTransportError("INVALID", "Invalid Codex RPC error response");
      }
      await reply(id, { id, error: { code: error.code, message: error.message } });
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => {
        notifications.delete(listener);
      };
    },
    onRequest(listener) {
      requests.add(listener);
      return () => {
        requests.delete(listener);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      if (terminal)
        queueMicrotask(() => {
          if (closeListeners.delete(listener)) notify(new Set([listener]), terminal!);
        });
      return () => {
        closeListeners.delete(listener);
      };
    },
    close() {
      return stop(new CodexTransportError("CLOSED", "Codex connection closed by client"));
    },
  };
}
