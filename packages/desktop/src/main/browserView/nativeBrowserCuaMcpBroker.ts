import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { BrowserWindow } from "electron";
import {
  CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
  NATIVE_BROWSER_CUA_SESSION_ID,
  NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX,
  nativeBrowserCuaMcpEndpointPath,
  nativeBrowserCuaMcpRequestSchema,
  nativeBrowserCuaMcpTokenFilePath,
  type BrowserCommandResult,
  type NativeBrowserCuaMcpDescriptor,
  type NativeBrowserCuaMcpResponse,
} from "@codez/shared";
import type { BrowserGuestManager } from "./browserGuestManager.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface NativeBrowserCuaMcpBroker {
  readonly ready: Promise<void>;
  readonly readiness: Promise<void>;
  readonly availability: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  };
  /**
   * 全局开关（spec: codex-desktop-native-browser-cua「Global enable toggle」）。
   * 关闭后所有请求在 schema 校验后立即 fail closed，能力描述符同步不可用。
   */
  setEnabled(enabled: boolean): void;
  registerWindow(windowId: number): Promise<void>;
  revokeWindow(windowId: number): Promise<void>;
  descriptor(input: {
    executable: string;
    bridgePath: string;
    windowId: number;
  }): NativeBrowserCuaMcpDescriptor;
  close(): Promise<void>;
}

interface WindowCapability {
  token: string;
  tokenFile: string;
  owned: boolean;
}

export function createNativeBrowserCuaMcpBroker(input: {
  manager: Pick<BrowserGuestManager, "execute">;
  platform?: NodeJS.Platform | string;
  flavor: string;
  userDataPath: string;
  eligibleWindowResolver: (windowId: number) => BrowserWindow | null;
  temporaryDirectory?: string;
  logger: {
    warn: (...args: unknown[]) => void;
  };
  tokenFileWriter?: (path: string, contents: string) => Promise<void>;
}): NativeBrowserCuaMcpBroker {
  const platform = input.platform ?? process.platform;
  const endpoint = nativeBrowserCuaMcpEndpointPath({
    platform,
    flavor: input.flavor,
    userDataPath: input.userDataPath,
    temporaryDirectory: input.temporaryDirectory ?? tmpdir(),
  });
  const windowCapabilities = new Map<number, WindowCapability>();
  const pendingWindowRegistrations = new Map<number, Promise<void>>();
  let closing: Promise<void> | undefined;
  let closed = false;
  let endpointReady = false;
  // 默认开启（与设置 schema 的 default(true) 一致）；Main 在设置加载/变更时校正。
  let enabled = true;
  // 凭据/socket 文件的属主标记：只有本进程确实监听成功并写过对应窗口 token，
  // close/revoke 才允许删除文件。否则 endpoint 被占用时（第二实例启动竞争）
  // 仍会走完 broker 创建，退出期 rm 会删掉正在服役实例的 socket 路径与凭据，
  // 使其 MCP 请求全部 authentication_failed（GUI 实测复现）。
  let endpointOwned = false;
  const server: Server = createServer((socket) => {
    void handleSocket(socket).catch((error: unknown) => {
      input.logger.warn("Native Browser/CUA MCP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.once("error", (error) => {
    closed = true;
    endpointReady = false;
    input.logger.warn("Native Browser/CUA MCP broker failed", error);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      endpointReady = !closed;
      endpointOwned = endpointReady;
      resolve();
    });
    server.once("error", reject);
  });
  server.listen(endpoint);
  const readiness = ready.catch(() => undefined);
  const currentAvailability = () => ({
    browserAvailable: !closed && endpointReady && enabled && windowCapabilities.size > 0,
    cuaAvailable: false,
  });

  const windowTokenFile = (windowId: number): string =>
    nativeBrowserCuaMcpTokenFilePath({
      flavor: input.flavor,
      userDataPath: input.userDataPath,
      windowId,
    });

  const windowScope = (windowId: number): string =>
    `${NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX}${input.flavor}-${windowId}`;

  return {
    ready,
    readiness,
    get availability() {
      return currentAvailability();
    },
    setEnabled(next) {
      enabled = next;
    },
    registerWindow: async (windowId) => {
      if (!Number.isSafeInteger(windowId) || windowId < 0) {
        throw new Error("Native Browser/CUA window id must be a nonnegative safe integer");
      }
      const existingRegistration = windowCapabilities.get(windowId);
      if (existingRegistration) return;
      const pendingRegistration = pendingWindowRegistrations.get(windowId);
      if (pendingRegistration) return await pendingRegistration;
      const registration = (async () => {
        if (closed || !endpointReady) await ready;
        if (windowCapabilities.has(windowId)) return;
        const token = randomBytes(32).toString("hex");
        const tokenFile = windowTokenFile(windowId);
        if (input.tokenFileWriter) {
          await input.tokenFileWriter(tokenFile, `${token}\n`);
        } else {
          await mkdir(dirname(tokenFile), { recursive: true });
          await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
          await chmod(tokenFile, 0o600);
        }
        if (closed) {
          await rm(tokenFile, { force: true });
          throw new Error("Native Browser/CUA MCP broker closed while registering window");
        }
        windowCapabilities.set(windowId, { token, tokenFile, owned: true });
      })();
      pendingWindowRegistrations.set(windowId, registration);
      try {
        await registration;
      } finally {
        if (pendingWindowRegistrations.get(windowId) === registration) {
          pendingWindowRegistrations.delete(windowId);
        }
      }
    },
    revokeWindow: async (windowId) => {
      const capability = windowCapabilities.get(windowId);
      windowCapabilities.delete(windowId);
      const pendingRegistration = pendingWindowRegistrations.get(windowId);
      if (pendingRegistration) await pendingRegistration.catch(() => undefined);
      const registered = windowCapabilities.get(windowId);
      if (capability?.owned) await rm(capability.tokenFile, { force: true });
      if (registered?.owned) {
        windowCapabilities.delete(windowId);
        await rm(registered.tokenFile, { force: true });
      }
    },
    descriptor: ({ executable, bridgePath, windowId }) => {
      const availability = currentAvailability();
      const tokenFile = windowTokenFile(windowId);
      return {
        runtimeInstalled: true,
        serviceRunning: availability.browserAvailable && windowCapabilities.has(windowId),
        executable,
        bridgePath,
        endpoint,
        tokenFile,
        ...availability,
        cuaReason: CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
      };
    },
    close: async () => {
      closing ??= (async () => {
        closed = true;
        await readiness;
        for (const pendingRegistration of pendingWindowRegistrations.values()) {
          await pendingRegistration.catch(() => undefined);
        }
        await ready.catch(() => undefined);
        if (!server.listening) {
          await ready.catch(() => undefined);
        } else {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const socket of sockets) socket.destroy();
          });
        }
        // 只有属主才能删除 endpoint/token 文件；监听失败实例的 close 不得
        // 删掉正在服役实例的 socket 路径（新 MCP 会话会 connect 失败）与凭据。
        if (platform !== "win32" && endpointOwned) await rm(endpoint, { force: true });
        for (const capability of windowCapabilities.values()) {
          if (capability.owned) await rm(capability.tokenFile, { force: true });
        }
      })();
      return await closing;
    },
  };

  async function handleSocket(socket: Socket): Promise<void> {
    const controller = new AbortController();
    socket.on("error", () => controller.abort());
    socket.once("close", () => controller.abort());
    let raw: string;
    try {
      raw = await readLine(socket, controller.signal);
    } catch {
      respond(invalidRequest(randomUUID(), "Native Browser/CUA request could not be read"));
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      respond(invalidRequest(randomUUID(), "Native Browser/CUA request is not valid JSON"));
      return;
    }
    const fallbackId = requestIdFromPayload(payload) ?? randomUUID();
    const parsedRequest = nativeBrowserCuaMcpRequestSchema.safeParse(payload);
    if (!parsedRequest.success) {
      respond(invalidRequest(fallbackId, "Native Browser/CUA request failed schema validation"));
      return;
    }
    const request = parsedRequest.data;
    if (!enabled) {
      respond({
        id: request.id,
        ok: false,
        error: "backend_unavailable",
        message: "Native Browser/CUA control is disabled by the user setting",
      });
      return;
    }
    const windowId = authorize(request.token);
    if (windowId === undefined) {
      respond({
        id: request.id,
        ok: false,
        error: "authentication_failed",
        message: "Native Browser/CUA request is not authorized",
      });
      return;
    }
    if (!currentAvailability().browserAvailable) {
      respond({
        id: request.id,
        ok: false,
        error: "backend_unavailable",
        message: "Native Browser/CUA broker is unavailable",
      });
      return;
    }
    const win = input.eligibleWindowResolver(windowId);
    if (!win) {
      respond({
        id: request.id,
        ok: false,
        error: "backend_unavailable",
        message: "No live local Desktop browser owner window",
      });
      return;
    }
    const result = await input.manager.execute(
      {
        requestId: request.id,
        // synthetic owner scope 的取值必须与 @codez/shared 的标记常量一致：
        // renderer 靠它们把原生浏览器 tab 识别为窗口级并落到侧边栏（不绑定会话）。
        browserId: request.browserId ?? windowScope(windowId),
        browserGeneration: request.browserGeneration ?? 0,
        windowId: win.id,
        workspaceKey: windowScope(windowId),
        sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
        clientMode: "desktop-continuous",
      },
      request.command,
      controller.signal,
    );
    respond({ id: request.id, ok: true, result: result satisfies BrowserCommandResult });

    function respond(response: NativeBrowserCuaMcpResponse): void {
      if (!socket.writable) return;
      socket.end(`${JSON.stringify(response)}\n`);
    }
  }

  function authorize(actual: string): number | undefined {
    for (const [windowId, capability] of windowCapabilities) {
      const left = Buffer.from(actual);
      const right = Buffer.from(capability.token);
      if (left.length === right.length && timingSafeEqual(left, right)) return windowId;
    }
    return undefined;
  }

  function invalidRequest(id: string, message: string): NativeBrowserCuaMcpResponse {
    return { id, ok: false, error: "invalid_request", message };
  }

  function requestIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const id = (payload as { id?: unknown }).id;
    return typeof id === "string" && UUID_PATTERN.test(id) ? id : undefined;
  }
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Native Browser/CUA request exceeded the 1 MiB limit"));
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
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
