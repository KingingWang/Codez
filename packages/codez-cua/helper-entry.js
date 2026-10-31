// 原 Helper factory 继续唯一持有认证、socket、shutdown 与 idle 状态。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  CuaHelperError,
  MAX_BROKER_REQUEST_BYTES,
  createHelperBootstrapRequest,
  handleRequestLine,
  parseHelperBootstrapCredentials,
  serializeResponse,
} from "./broker.js";
import { HELPER_BUNDLE_ID, HELPER_CONTROL_PROTOCOL } from "./broker-helper-constants.js";
import { createInstalledAppLauncher } from "./installed-app-launcher.js";
import { createMacOsPipPresenter } from "./pip-presentation-macos.js";
import { createPipSessionCoordinator } from "./pip-session-coordinator.js";
import { createPipSessionServer } from "./pip-session-server.js";
import { createXa11yProducer } from "./xa11y-producer.js";
import { discoverWindowsApps } from "./windows-app-discovery.js";
import {
  loadHelperXa11y,
  preflightLinuxHelperCapabilities,
  probePermission,
  readHelperPermissionStatus,
  createPermissionAdapter,
  createPasteAdapter,
} from "./helper-runtime/native-access.js";
import {
  isPlainObject,
  projectProducerResult,
  producerError,
  trustedCaptureFromResult,
} from "./helper-runtime/result-projection.js";
export {
  loadHelperXa11y,
  preflightLinuxHelperCapabilities,
  readHelperPermissionStatus,
} from "./helper-runtime/native-access.js";
export { projectProducerResult } from "./helper-runtime/result-projection.js";

const PARENT_CHECK_INTERVAL_MS = 2000;
const STANDALONE_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS = 30_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const VALUE_ARGUMENTS = new Map([
  ["--socket", "socketPath"],
  ["--broker-socket", "socketPath"],
  ["--pip-socket", "pipSocketPath"],
  ["--parent-pid", "parentPid"],
  ["--launcher-pid", "parentPid"],
  ["--exit-log", "exitLogPath"],
  ["--pip-mode", "pipMode"],
  ["--permission-request", "permissionRequest"],
  ["--permission-preflight", "permissionPreflight"],
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CuaHelperError(`${label} is required.`, { code: "invalid_request" });
  }
  return value.trim();
}

export function parseHelperArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
  }
  const values = new Map();
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index];
    if (typeof flag !== "string") {
      throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
    }
    const valueName = VALUE_ARGUMENTS.get(flag);
    const value = argv[index + 1];
    if (!valueName || value === undefined || values.has(valueName)) {
      throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
    }
    values.set(valueName, value);
    index += 2;
  }
  const socketPath = requiredString(values.get("socketPath"), "Helper socket path");
  const rawParentPid = values.get("parentPid");
  const parentPid = rawParentPid === undefined ? undefined : Number(rawParentPid);
  if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid <= 0)) {
    throw new CuaHelperError("Helper parent pid must be a positive safe integer.", {
      code: "invalid_request",
    });
  }
  const permissionRequest = values.get("permissionRequest");
  if (
    permissionRequest !== undefined &&
    permissionRequest !== "accessibility" &&
    permissionRequest !== "screen_recording"
  ) {
    throw new CuaHelperError("Helper permission request is invalid.", {
      code: "invalid_request",
    });
  }
  const permissionPreflight = values.get("permissionPreflight");
  if (permissionPreflight !== undefined && permissionPreflight !== "screen_recording") {
    throw new CuaHelperError("Helper permission preflight is invalid.", {
      code: "invalid_request",
    });
  }
  if (permissionRequest && permissionPreflight) {
    throw new CuaHelperError("Helper permission modes are mutually exclusive.", {
      code: "invalid_request",
    });
  }
  const exitLogPath =
    values.get("exitLogPath") === undefined
      ? undefined
      : requiredString(values.get("exitLogPath"), "Helper exit log path");
  const pipMode = values.get("pipMode");
  if (pipMode !== undefined && pipMode !== "enabled" && pipMode !== "disabled") {
    throw new CuaHelperError("Helper PiP mode is invalid.", { code: "invalid_request" });
  }
  const pipSocketPath =
    values.get("pipSocketPath") === undefined
      ? undefined
      : requiredString(values.get("pipSocketPath"), "Helper PiP socket path");
  if (pipSocketPath === socketPath) {
    throw new CuaHelperError("Helper broker and PiP sockets must be different.", {
      code: "invalid_request",
    });
  }
  if (pipMode === "enabled" && (!pipSocketPath || parentPid === undefined)) {
    throw new CuaHelperError(
      "Helper PiP socket and managed parent are required when PiP is enabled.",
      { code: "invalid_request" },
    );
  }
  if (pipSocketPath && pipMode !== "enabled") {
    throw new CuaHelperError("Helper PiP socket requires enabled PiP mode.", {
      code: "invalid_request",
    });
  }
  return {
    socketPath,
    ...(pipSocketPath ? { pipSocketPath } : {}),
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(exitLogPath ? { exitLogPath } : {}),
    ...(pipMode ? { pipMode } : {}),
    ...(permissionRequest ? { permissionRequest } : {}),
    ...(permissionPreflight ? { permissionPreflight } : {}),
  };
}

function equalCapability(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createHelperBackend(options) {
  const { capability, generation, producer } = options;
  let disposed = false;
  let tail = Promise.resolve();
  const serialize = (work) => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    authorize(request) {
      const authorized =
        !disposed &&
        request.generation === generation &&
        equalCapability(request.capability, capability);
      if (authorized) options.onActivity?.();
      return authorized;
    },
    ping() {
      options.onActivity?.();
      return { ok: true };
    },
    broker_info() {
      options.onActivity?.();
      return { bundleId: options.bundleId ?? null, pid: process.pid };
    },
    permission_status() {
      options.onActivity?.();
      return options.permissionStatus?.() ?? { available: !disposed, platform: process.platform };
    },
    execute(params) {
      options.onActivity?.();
      return serialize(async () => {
        if (disposed)
          throw new CuaHelperError("Computer Use Helper is stopped.", { code: "controller_busy" });
        if (!isPlainObject(params) || !isPlainObject(params.context)) {
          throw new CuaHelperError("Computer Use execute request is invalid.", {
            code: "invalid_request",
          });
        }
        try {
          const value = await producer.dispatch(params.method, params.input, params.context);
          const capture = trustedCaptureFromResult(
            params.method,
            params.input,
            value,
            params.context,
          );
          if (capture && typeof options.onTrustedCapture === "function") {
            try {
              await options.onTrustedCapture(capture);
            } catch (error) {
              // PiP 是旁路展示；presenter 故障必须回滚其状态，但不能让真实读屏结果失败。
              try {
                await options.onPipError?.(error);
              } catch {
                // 故障清理和诊断同样属于 PiP 旁路，不能反向改变 broker 的观测结果。
              }
            }
          }
          return { result: projectProducerResult(params.method, value), responseMeta: {} };
        } catch (error) {
          throw producerError(error);
        }
      });
    },
    close_session(params) {
      options.onActivity?.();
      return serialize(async () => {
        if (isPlainObject(params?.context)) await producer.closeSession(params.context);
        return { closed: true };
      });
    },
    shutdown() {
      options.onActivity?.();
      options.requestShutdown?.();
      return { shuttingDown: true };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await tail;
      await producer.dispose();
    },
  };
}

async function removeUnixSocket(socketPath, platform) {
  if (platform === "win32") return;
  await rm(socketPath, { force: true });
}

function readRequest(socket, backend) {
  let bytes = 0;
  const chunks = [];
  let complete = false;
  const fail = (response) => {
    if (complete) return;
    complete = true;
    socket.end(serializeResponse(response));
  };
  socket.on("data", (chunk) => {
    if (complete) return;
    const newline = chunk.indexOf(0x0a);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    bytes += part.length;
    if (bytes > MAX_BROKER_REQUEST_BYTES) {
      fail({
        ok: false,
        error: {
          code: "request_too_large",
          message: "Computer Use broker request exceeded the 1 MiB limit.",
        },
      });
      return;
    }
    chunks.push(part);
    if (newline < 0) return;
    if (newline !== chunk.length - 1) {
      fail({
        ok: false,
        error: {
          code: "invalid_request",
          message: "Computer Use broker accepts one request per connection.",
        },
      });
      return;
    }
    complete = true;
    let line;
    try {
      line = utf8Decoder.decode(Buffer.concat(chunks, bytes));
    } catch {
      socket.end(
        serializeResponse({
          ok: false,
          error: {
            code: "invalid_request",
            message: "Computer Use broker request is not valid UTF-8.",
          },
        }),
      );
      return;
    }
    void handleRequestLine(backend, line).then(
      (response) => socket.end(serializeResponse(response)),
      (error) =>
        socket.end(
          serializeResponse({
            ok: false,
            error: {
              code: "internal",
              message:
                error instanceof Error ? error.message : "Computer Use Helper request failed.",
            },
          }),
        ),
    );
  });
  socket.once("error", () => {
    complete = true;
  });
}

export async function createHelperBrokerServer(options) {
  const socketPath = requiredString(options?.socketPath, "Helper socket path");
  const platform = options?.platform ?? process.platform;
  await removeUnixSocket(socketPath, platform);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    readRequest(socket, options.backend);
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    server.once("listening", resolveReady);
    server.once("error", rejectReady);
  });
  server.listen(socketPath);
  await ready;
  if (platform !== "win32") await chmod(socketPath, 0o600);
  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await removeUnixSocket(socketPath, platform);
    },
  };
}

function createExitLogger(path) {
  return async (event, details = {}) => {
    if (!path) return;
    try {
      await appendFile(
        path,
        `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // 诊断日志不能改变权限裁决或 Helper 生命周期；写失败只丢失诊断，不得放宽执行门。
    }
  };
}

export async function runHelperPermissionMode(options) {
  const { args, xa11y } = options;
  const capability = args.permissionRequest ?? args.permissionPreflight;
  if (!capability) return undefined;
  const result = await probePermission(xa11y, capability);
  await options.logExit?.(args.permissionRequest ? "permission_request" : "permission_preflight", {
    capability,
    state: result.state,
    ...(result.error ? { error: result.error } : {}),
  });
  return { capability, ...result };
}

export function waitForHelperCredentialBootstrap(options = {}) {
  const channel = options.channel ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS
  ) {
    return Promise.reject(
      new CuaHelperError("Helper credential bootstrap timeout is invalid.", {
        code: "invalid_request",
      }),
    );
  }
  const request = createHelperBootstrapRequest({
    pid: options.pid ?? process.pid,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  if (
    typeof channel?.on !== "function" ||
    typeof channel?.off !== "function" ||
    typeof channel?.once !== "function" ||
    typeof channel?.send !== "function" ||
    channel.connected === false
  ) {
    return Promise.reject(
      new CuaHelperError("Helper credential bootstrap IPC is unavailable.", {
        code: "broker_unavailable",
      }),
    );
  }

  return new Promise((resolveBootstrap, rejectBootstrap) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      channel.off("message", onMessage);
      channel.off("disconnect", onDisconnect);
    };
    const fail = (message, code = "broker_unavailable") => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBootstrap(new CuaHelperError(message, { code }));
    };
    const onDisconnect = () => {
      fail("Helper credential bootstrap IPC disconnected.");
    };
    const onMessage = (message) => {
      if (settled) return;
      const credentials = parseHelperBootstrapCredentials(message);
      if (!credentials || credentials.pid !== request.pid || credentials.nonce !== request.nonce) {
        fail("Helper credential bootstrap response is invalid.", "invalid_request");
        return;
      }
      settled = true;
      cleanup();
      resolveBootstrap({
        capability: credentials.capability,
        generation: credentials.generation,
      });
    };
    const timer = setTimeout(() => fail("Helper credential bootstrap timed out."), timeoutMs);
    timer.unref?.();
    channel.on("message", onMessage);
    channel.once("disconnect", onDisconnect);
    try {
      // 根因：SEA 会在入口完整性检查后才注册 message listener；由 Helper 主动 challenge，
      // Host 收到后再回凭据，避免父进程 spawn 后盲发造成静默丢消息。
      channel.send(request, (error) => {
        if (error) fail(`Helper credential bootstrap request failed: ${error.message}`);
      });
    } catch (error) {
      fail(
        `Helper credential bootstrap request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function sendControl(type, details = {}) {
  if (typeof process.send !== "function") return;
  process.send({ protocol: HELPER_CONTROL_PROTOCOL, type, ...details });
}

function watchParent(parentPid, requestShutdown) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      requestShutdown();
    }
  }, PARENT_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runHelperProcess(options = {}) {
  const args = options.args ?? parseHelperArguments(process.argv.slice(2));
  const logExit = options.logExit ?? createExitLogger(args.exitLogPath);
  const loadXa11y = options.loadXa11y ?? loadHelperXa11y;
  const permissionMode =
    args.permissionRequest !== undefined || args.permissionPreflight !== undefined;
  if (permissionMode) {
    const xa11y = options.xa11y ?? (await loadXa11y({ env: options.env }));
    return runHelperPermissionMode({ args, xa11y, logExit });
  }
  const credentials =
    args.parentPid === undefined
      ? { capability: randomBytes(32).toString("base64url"), generation: 0 }
      : await (options.waitForCredentialBootstrap ?? waitForHelperCredentialBootstrap)({
          channel: options.controlChannel,
          pid: options.pid ?? process.pid,
          timeoutMs: options.credentialBootstrapTimeoutMs,
        });
  // 正常常驻模式必须先拿到一次性 IPC tuple，之后才允许加载原生绑定或绑定 socket。
  const xa11y = options.xa11y ?? (await loadXa11y({ env: options.env }));
  const permissionResult = await runHelperPermissionMode({ args, xa11y, logExit });
  if (permissionResult) return permissionResult;
  await preflightLinuxHelperCapabilities({
    platform: options.platform,
    env: options.env,
    xa11y,
    accessFile: options.accessFile,
  });
  let shutdownPromise;
  let server;
  let pipServer;
  let pipCoordinator;
  let idleTimer;
  const idleTimeoutMs = options.standaloneIdleTimeoutMs ?? STANDALONE_IDLE_TIMEOUT_MS;
  const producer =
    options.producer ??
    createXa11yProducer({
      loadXa11y: async () => xa11y,
      platform: options.platform,
      ...((options.platform ?? process.platform) === "win32"
        ? { discoverApps: discoverWindowsApps }
        : {}),
      requestAccess: createPermissionAdapter(xa11y),
      paste: createPasteAdapter(xa11y),
      launcher:
        options.launcher ??
        createInstalledAppLauncher({
          platform: options.platform,
          env: options.env,
        }),
      motionProfile: options.motionProfile ?? (options.env ?? process.env).CODEZ_CUA_MOTION_PROFILE,
    });
  let backend;
  const requestShutdown = () => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      if (idleTimer) clearTimeout(idleTimer);
      await pipServer?.close().catch(() => undefined);
      await backend?.dispose();
      await server?.close();
      await logExit("stopped");
    });
    return shutdownPromise;
  };
  const touchActivity = () => {
    if (args.parentPid !== undefined || shutdownPromise) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(requestShutdown, idleTimeoutMs);
    idleTimer.unref?.();
  };
  backend = createHelperBackend({
    // 设置页允许只读匿名探测。没有 Host credential tuple 时生成进程内随机秘密，确保所有
    // mutation 仍不可达；不能用空串，否则外部客户端可把“standalone”误当授权模式。
    capability: credentials.capability,
    generation: credentials.generation,
    producer,
    bundleId:
      options.platform === "darwin" || process.platform === "darwin" ? HELPER_BUNDLE_ID : null,
    permissionStatus: () => readHelperPermissionStatus(xa11y),
    onActivity: touchActivity,
    onTrustedCapture: async (capture) => {
      if (!pipCoordinator) return;
      const result = await pipCoordinator.bindCapture(capture);
      if (!result.accepted) {
        await logExit("pip_capture_rejected", { reason: result.reason });
      }
    },
    onPipError: async (error) => {
      const failedCoordinator = pipCoordinator;
      pipCoordinator = undefined;
      await failedCoordinator?.dispose().catch(() => undefined);
      await logExit("pip_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
    // 不能用 microtask 立刻关 server：它会先于 handleRequestLine 的响应续体执行，导致已认证
    // shutdown 在客户端表现为“可能已发送但连接断开”。推迟到下一事件循环，先完整回包再回收。
    requestShutdown: () => setImmediate(requestShutdown),
  });
  if (args.pipMode === "enabled") {
    try {
      const presenterFactory = options.createPipPresenter ?? createMacOsPipPresenter;
      const presenter = await presenterFactory({ env: options.env });
      pipCoordinator = createPipSessionCoordinator({ presenter });
    } catch (error) {
      await logExit("pip_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const pipServerFactory = options.createPipServer ?? createPipSessionServer;
      pipServer = await pipServerFactory({
        socketPath: args.pipSocketPath,
        capability: credentials.capability,
        generation: credentials.generation,
        coordinator: pipCoordinator ?? null,
        available: pipCoordinator !== undefined,
        platform: options.platform,
        onActivity: touchActivity,
      });
    } catch (error) {
      await pipCoordinator?.dispose().catch(() => undefined);
      pipCoordinator = undefined;
      await logExit("pip_server_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    server = await createHelperBrokerServer({
      socketPath: args.socketPath,
      backend,
      platform: options.platform,
    });
  } catch (error) {
    // broker bind 失败发生在 PiP 已启动之后；若直接抛出会留下 presenter 与独立 socket。
    await pipServer?.close().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    throw error;
  }
  sendControl("transport_ready", { socketPath: args.socketPath, pid: process.pid });
  sendControl("ready", { socketPath: args.socketPath, pid: process.pid });
  await logExit("ready", { socketPath: args.socketPath, pid: process.pid });
  const stopWatching =
    args.parentPid === undefined ? () => {} : watchParent(args.parentPid, requestShutdown);
  touchActivity();
  const onMessage = (message) => {
    if (message?.protocol === HELPER_CONTROL_PROTOCOL && message.type === "shutdown") {
      void requestShutdown();
    }
  };
  process.on("message", onMessage);
  const onSignal = () => void requestShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await new Promise((resolveStopped) => {
    const wait = () => {
      if (shutdownPromise) shutdownPromise.finally(resolveStopped);
      else setTimeout(wait, 10).unref?.();
    };
    wait();
  });
  stopWatching();
  process.off("message", onMessage);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return { stopped: true };
}

function isDirectEntrypoint() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint()) {
  runHelperProcess().catch((error) => {
    sendControl("error", {
      message: error instanceof Error ? error.message : "Computer Use Helper startup failed.",
    });
    process.exitCode = 1;
  });
}
