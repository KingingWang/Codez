import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { Emitter } from "@codez/rpc";
import {
  NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES,
  NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES,
  nativeBrowserCuaRelayEndpointPath,
  nativeBrowserCuaRelayTokenFilePath,
  type DesktopBrowserCommandRelayRequest,
  type NativeBrowserCuaMcpResponse,
} from "@codez/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

type RelayLogger = { warn: (traceId: undefined, ...args: unknown[]) => void };

/**
 * 远端 relay（spec: codex-desktop-native-browser-cua「Remote workspace relay」）。
 *
 * desktop-attached-remote server 在本机提供与 Main broker 同构的单请求 socket：
 * bridge.cjs 用 remote-local token 鉴权后，请求经 RPC 事件转发到桌面窗口 Host，
 * Host 换入窗口 token 打给 Main broker，响应经 respondDesktopBrowserCommand 回写。
 * 窗口 token 永不离开桌面进程；远端文件系统只持有本 relay 自签发的 token。
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface DesktopBrowserRelayDescriptor {
  endpoint: string;
  tokenFile: string;
}

export interface DesktopBrowserRelay {
  /** relay socket 正在监听且 token 有效。 */
  readonly active: boolean;
  /** spawn env 注入用：仅在 active 时返回描述符。 */
  activeDescriptor(): DesktopBrowserRelayDescriptor | undefined;
  /** 授予/撤销能力；返回状态是否发生变化（调用方据此决定是否重造 runtime）。 */
  setEnabled(enabled: boolean): Promise<boolean>;
  /** desktop 回传中继结果（原始 broker 响应行，不含换行）。未知 requestId 记录 warn。 */
  resolveCommand(requestId: string, payload: string): void;
  onCommandRequest(listener: (request: DesktopBrowserCommandRelayRequest) => void): {
    dispose(): void;
  };
  dispose(): Promise<void>;
}

interface PendingRelayRequest {
  requestId: string;
  brokerRequestId: string;
  payload: string;
  /** 已投递过 listener 的请求不重放，避免 click 等副作用命令被重复执行。 */
  delivered: boolean;
  socket: Socket;
  timer: ReturnType<typeof setTimeout>;
}

export function createDesktopBrowserRelay(options: {
  dataDirectory: string;
  platform?: NodeJS.Platform | string;
  processId?: number;
  temporaryDirectory?: string;
  requestTimeoutMs?: number;
  logger?: RelayLogger;
}): DesktopBrowserRelay {
  const logger: RelayLogger =
    options.logger ?? createServiceLogger("services.codez_agent.desktop_browser_relay");
  const platform = options.platform ?? process.platform;
  const processId = options.processId ?? process.pid;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const endpoint = nativeBrowserCuaRelayEndpointPath({
    platform,
    processId,
    temporaryDirectory: options.temporaryDirectory ?? tmpdir(),
  });
  const tokenFile = nativeBrowserCuaRelayTokenFilePath({
    dataDirectory: options.dataDirectory,
    processId,
  });
  const commandRequestEmitter = new Emitter<DesktopBrowserCommandRelayRequest>();
  const pending = new Map<string, PendingRelayRequest>();
  const sockets = new Set<Socket>();
  let listenerCount = 0;

  let server: Server | undefined;
  let token: string | undefined;
  let active = false;
  let disposed = false;
  let startQueue: Promise<void> = Promise.resolve();

  const failResponse = (
    id: string,
    error: "authentication_failed" | "backend_unavailable" | "invalid_request",
    message: string,
  ): NativeBrowserCuaMcpResponse => ({ id, ok: false, error, message });

  const writeResponse = (socket: Socket, response: NativeBrowserCuaMcpResponse): void => {
    if (!socket.writable) return;
    socket.end(`${JSON.stringify(response)}\n`);
  };

  const settlePending = (entry: PendingRelayRequest, payload: string): void => {
    if (pending.get(entry.requestId) !== entry) return;
    pending.delete(entry.requestId);
    clearTimeout(entry.timer);
    if (!entry.socket.writable) return;
    entry.socket.end(`${payload}\n`);
  };

  const failPending = (entry: PendingRelayRequest, message: string): void => {
    settlePending(
      entry,
      JSON.stringify(failResponse(entry.brokerRequestId, "backend_unavailable", message)),
    );
  };

  const readRequestLine = (socket: Socket): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let buffer = "";
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES) {
          cleanup();
          reject(new Error("relay request exceeded the 1 MiB limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        cleanup();
        resolve(buffer.slice(0, newline));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("relay socket closed before a request line arrived"));
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });

  const tokenMatches = (actual: unknown): actual is string => {
    if (typeof actual !== "string" || !token) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  };

  const requestIdFromPayload = (payload: unknown): string | undefined => {
    if (!payload || typeof payload !== "object") return undefined;
    const id = (payload as { id?: unknown }).id;
    return typeof id === "string" && UUID_PATTERN.test(id) ? id : undefined;
  };

  const handleSocket = (socket: Socket): void => {
    void (async () => {
      const raw = await readRequestLine(socket);
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        writeResponse(
          socket,
          failResponse(randomUUID(), "invalid_request", "relay request is not valid JSON"),
        );
        return;
      }
      const brokerRequestId = requestIdFromPayload(payload) ?? randomUUID();
      // relay 只校验 remote-local token；命令 schema 由 Main broker 同源复验，
      // relay 不复制校验规则，避免双层规则漂移。
      if (!tokenMatches((payload as { token?: unknown }).token)) {
        writeResponse(
          socket,
          failResponse(brokerRequestId, "authentication_failed", "relay request is not authorized"),
        );
        return;
      }
      const requestId = randomUUID();
      const entry: PendingRelayRequest = {
        requestId,
        brokerRequestId,
        payload: raw,
        delivered: listenerCount > 0,
        socket,
        timer: setTimeout(() => {
          failPending(entry, "Desktop browser relay request timed out");
        }, requestTimeoutMs),
      };
      pending.set(requestId, entry);
      socket.once("close", () => {
        if (pending.get(requestId) === entry) {
          pending.delete(requestId);
          clearTimeout(entry.timer);
        }
      });
      commandRequestEmitter.fire({ requestId, payload: raw });
    })().catch((error: unknown) => {
      logger.warn(undefined, "relay request failed before dispatch", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (socket.writable) {
        writeResponse(
          socket,
          failResponse(randomUUID(), "invalid_request", "relay request could not be read"),
        );
      }
    });
  };

  const stop = async (): Promise<void> => {
    active = false;
    token = undefined;
    for (const entry of pending.values()) {
      failPending(entry, "Desktop browser relay is disabled");
    }
    pending.clear();
    const current = server;
    server = undefined;
    if (current) {
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    }
    // pid 作用域路径只属于本进程；关闭后清理，避免 stale 凭据/socket 残留。
    await rm(tokenFile, { force: true }).catch(() => undefined);
    if (platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
  };

  const start = async (): Promise<void> => {
    token = randomBytes(32).toString("hex");
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const next = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      handleSocket(socket);
    });
    try {
      if (platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        next.listen(endpoint, () => {
          next.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      await rm(tokenFile, { force: true }).catch(() => undefined);
      token = undefined;
      throw error;
    }
    server = next;
    active = true;
  };

  return {
    get active() {
      return active && !disposed;
    },
    activeDescriptor() {
      return this.active ? { endpoint, tokenFile } : undefined;
    },
    setEnabled(enabled) {
      // 串行化启停：快速连拨开关时 listen/close 竞争会留下半开 socket。
      const queued = startQueue.then(async () => {
        if (disposed) return false;
        if (enabled === this.active) return false;
        if (!enabled) {
          await stop();
          return true;
        }
        try {
          await start();
        } catch (error) {
          // 启动失败必须 fail closed：仅禁用本工具，不影响远端 server 主流程。
          logger.warn(undefined, "relay failed to start; browser control stays unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
          await stop().catch(() => undefined);
        }
        return true;
      });
      startQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    resolveCommand(requestId, payload) {
      const entry = pending.get(requestId);
      if (!entry) {
        logger.warn(undefined, "relay response without a pending request", { requestId });
        return;
      }
      if (Buffer.byteLength(payload) > NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES) {
        failPending(entry, "Desktop browser relay response exceeded the 32 MiB limit");
        return;
      }
      settlePending(entry, payload);
    },
    onCommandRequest(listener) {
      listenerCount += 1;
      const subscription = commandRequestEmitter.event(listener);
      // 与 runtime-preferences 同款补偿：listener 晚于请求到达时补发「从未投递」的在途请求，
      // 避免 Host 侧重建 listener 期间到达的调用只能等超时；已投递请求不重放（副作用安全）。
      for (const entry of pending.values()) {
        if (entry.delivered) continue;
        entry.delivered = true;
        listener({ requestId: entry.requestId, payload: entry.payload });
      }
      return {
        dispose: () => {
          listenerCount = Math.max(0, listenerCount - 1);
          subscription.dispose();
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await startQueue.catch(() => undefined);
      await stop();
      commandRequestEmitter.dispose();
    },
  };
}
