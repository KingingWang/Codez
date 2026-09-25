import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { BrowserWindow } from "electron";
import {
  CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
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
  readonly tokenReady: Promise<void>;
  readonly readiness: Promise<void>;
  readonly availability: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  };
  descriptor(input: { executable: string; bridgePath: string }): NativeBrowserCuaMcpDescriptor;
  close(): Promise<void>;
}

export function createNativeBrowserCuaMcpBroker(input: {
  manager: Pick<BrowserGuestManager, "execute">;
  platform?: NodeJS.Platform | string;
  flavor: string;
  userDataPath: string;
  eligibleWindowResolver: () => BrowserWindow | null;
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
  const tokenFile = nativeBrowserCuaMcpTokenFilePath({
    flavor: input.flavor,
    userDataPath: input.userDataPath,
  });
  const token = randomBytes(32).toString("hex");
  let closing: Promise<void> | undefined;
  let closed = false;
  let endpointReady = false;
  let tokenFileReady = false;
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
      resolve();
    });
    server.once("error", reject);
  });
  server.listen(endpoint);
  const writeToken: Promise<void> = input.tokenFileWriter
    ? input.tokenFileWriter(tokenFile, `${token}\n`)
    : (async () => {
        await mkdir(dirname(tokenFile), { recursive: true });
        await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
        await chmod(tokenFile, 0o600);
      })();
  void ready.catch(() => undefined);
  void writeToken
    .then(() => {
      tokenFileReady = !closed;
    })
    .catch((error: unknown) => {
      input.logger.warn("Native Browser/CUA token write failed", error);
    });
  const readiness = Promise.allSettled([ready, writeToken]).then(() => undefined);
  const currentAvailability = () => ({
    browserAvailable: !closed && endpointReady && tokenFileReady,
    cuaAvailable: false,
  });

  return {
    ready,
    tokenReady: writeToken,
    readiness,
    get availability() {
      return currentAvailability();
    },
    descriptor: ({ executable, bridgePath }) => {
      const availability = currentAvailability();
      return {
        runtimeInstalled: true,
        serviceRunning: availability.browserAvailable,
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
        await ready.catch(() => undefined);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        if (platform !== "win32") await rm(endpoint, { force: true });
        await rm(tokenFile, { force: true });
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
    if (!authorize(request.token, token)) {
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
    const win = input.eligibleWindowResolver();
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
        browserId: request.browserId ?? `native-browser-cua:${input.flavor}`,
        browserGeneration: request.browserGeneration ?? 0,
        windowId: win.id,
        workspaceKey: `native-browser-cua:${input.flavor}`,
        sessionId: "codex-native-browser-cua",
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

  function authorize(actual: string, expected: string): boolean {
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
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
