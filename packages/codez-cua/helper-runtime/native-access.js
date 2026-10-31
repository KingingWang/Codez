// 原 Helper 的无状态 native/权限适配器；不缓存权限或持有进程 lifecycle。
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CuaHelperError } from "../broker.js";
import {
  HELPER_ADDON_ENV,
  HELPER_BUNDLE_ID,
  HELPER_DISPLAY_NAME,
} from "../broker-helper-constants.js";
import { isXa11yPermissionDenied } from "../xa11y-errors.js";

const LINUX_PREFLIGHT_ERRORS = Object.freeze({
  NO_DISPLAY: "Linux Computer Use Helper requires an X11 or Wayland display session.",
  UINPUT_DENIED: "Linux Wayland Computer Use requires writable /dev/uinput.",
  ATSPI_UNAVAILABLE: "Linux Computer Use Helper AT-SPI capability is unavailable.",
  INPUT_UNAVAILABLE: "Linux Computer Use Helper input simulation capability is unavailable.",
});

function normalizeXa11yModule(module) {
  // Node 对 CJS 的动态 import 会合成部分具名导出；xa11y 的 App 可能在 namespace 上，
  // screenshot/inputSim 却只在 default 上。必须优先完整 default，否则 Helper 启动后截图必坏。
  if (module?.default && typeof module.default === "object") return module.default;
  if (module && typeof module === "object" && module.App) return module;
  throw new CuaHelperError("xa11y native module is unavailable.", {
    code: "broker_unavailable",
  });
}

export async function loadHelperXa11y(options = {}) {
  const env = options.env ?? process.env;
  const configuredPath = env[HELPER_ADDON_ENV]?.trim();
  if (!configuredPath) {
    return normalizeXa11yModule(await import("@crowecawcaw/xa11y"));
  }
  const loader = await import(pathToFileURL(resolve(configuredPath)).href);
  const load = loader.loadXa11y ?? loader.default;
  if (typeof load !== "function") {
    throw new CuaHelperError("Configured xa11y loader has no load function.", {
      code: "broker_unavailable",
    });
  }
  return normalizeXa11yModule(await load());
}

function linuxPreflightError(message) {
  return new CuaHelperError(message, { code: "broker_unavailable" });
}

function detectLinuxDisplaySession(env) {
  const sessionType =
    typeof env?.XDG_SESSION_TYPE === "string" ? env.XDG_SESSION_TYPE.trim().toLowerCase() : "";
  const hasWaylandDisplay =
    typeof env?.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.trim().length > 0;
  const hasX11Display = typeof env?.DISPLAY === "string" && env.DISPLAY.trim().length > 0;
  // Bug 根因：systemd/SSH 环境可能继承 XDG_SESSION_TYPE，却没有显示 socket；只看 session type
  // 会把无显示 Helper 误判为可用。它只用于两种 socket 同时存在时选择当前会话。
  if (sessionType === "wayland" && hasWaylandDisplay) return "wayland";
  if (sessionType === "x11" && hasX11Display) return "x11";
  if (hasWaylandDisplay) return "wayland";
  if (hasX11Display) return "x11";
  throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.NO_DISPLAY);
}

export async function preflightLinuxHelperCapabilities(options) {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") return;
  const xa11y = options?.xa11y;
  const session = detectLinuxDisplaySession(options?.env ?? process.env);
  if (session === "wayland") {
    try {
      // Bug 根因：只验证 inputSim 能构造会把 /dev/uinput 的权限错误推迟到首个真实输入；
      // 必须由即将执行动作的同一 Helper 进程先做 W_OK 检查，不能由 Host 代查身份。
      await (options?.accessFile ?? access)("/dev/uinput", fsConstants.W_OK);
    } catch {
      throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.UINPUT_DENIED);
    }
  }
  try {
    if (!xa11y?.App || typeof xa11y.App.list !== "function") throw new Error("missing App.list");
    const apps = await xa11y.App.list();
    if (!Array.isArray(apps)) throw new Error("invalid App.list result");
  } catch {
    throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.ATSPI_UNAVAILABLE);
  }
  try {
    if (typeof xa11y?.inputSim !== "function") throw new Error("missing inputSim");
    const simulator = await xa11y.inputSim();
    if (
      !simulator ||
      (typeof simulator !== "object" && typeof simulator !== "function") ||
      (simulator.dispose !== undefined && typeof simulator.dispose !== "function")
    ) {
      throw new Error("invalid inputSim result");
    }
    // xa11y 0.15 的 InputSim 随 JS wrapper 生命周期释放，没有公开 dispose；未来版本若提供
    // 显式钩子则必须在 ready 前调用并等待完成，当前版本则在函数返回时丢弃唯一局部引用。
    await simulator.dispose?.();
  } catch {
    // Bug 根因：延迟创建 inputSim 会让 Helper 先发布 ready，再在第一次 click/key 时才暴露
    // 原生驱动或权限故障。启动门必须验证初始化和释放都成功，且不能产生输入副作用。
    throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.INPUT_UNAVAILABLE);
  }
}

async function probePermission(xa11y, capability, platform = process.platform) {
  try {
    if (capability === "screen_recording") {
      const screenshot = await xa11y.screenshot();
      const width = screenshot?.width;
      const height = screenshot?.height;
      const png = screenshot?.toPng?.();
      // 根因：原生绑定在 ABI 不匹配时可能 resolve 空对象；仅以“不抛异常”判 granted
      // 会把不可用的截图权限误报为已授权，因此必须校验真实栅格和 PNG 结果。
      if (
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        !Buffer.isBuffer(png) ||
        png.length === 0
      ) {
        throw new Error("screen recording probe returned an invalid screenshot");
      }
    } else if (platform === "win32") {
      // 全桌面 App.list 超时不等于权限拒绝；前台绑定走 HWND，不访问无关 UIA provider。
      const app = await xa11y.App.foreground({ timeout: 0 });
      if (!Number.isSafeInteger(app?.pid) || app.pid <= 0) {
        throw new Error("accessibility probe has no foreground application");
      }
    } else {
      const apps = await xa11y.App.list();
      if (!Array.isArray(apps)) {
        throw new Error("accessibility probe returned an invalid app list");
      }
    }
    return { state: "granted" };
  } catch (error) {
    return {
      // 枚举超时、原生结果损坏都不是权限裁决，不能引导用户反复授权。
      state: isXa11yPermissionDenied(error) ? "denied" : "unknown",
      error: error instanceof Error ? error.message : "permission probe failed",
    };
  }
}

export async function readHelperPermissionStatus(xa11y, options = {}) {
  const platform = options.platform ?? process.platform;
  const [accessibility, screenRecording] = await Promise.all([
    probePermission(xa11y, "accessibility", platform),
    probePermission(xa11y, "screen_recording", platform),
  ]);
  return {
    available: true,
    platform,
    grant_owner: HELPER_BUNDLE_ID,
    owner: { bundle_id: HELPER_BUNDLE_ID, display_name: HELPER_DISPLAY_NAME },
    accessibility: accessibility.state,
    accessibility_probe_ok: accessibility.state === "granted",
    accessibility_probe: {
      ok: accessibility.state === "granted",
      ...(accessibility.error ? { reason: accessibility.error } : {}),
    },
    screen_recording: screenRecording.state,
    screen_capture_probe: {
      ok: screenRecording.state === "granted",
      ...(screenRecording.error ? { reason: screenRecording.error } : {}),
    },
  };
}

function createPermissionAdapter(xa11y) {
  return async ({ capabilities }) => {
    const requested =
      Array.isArray(capabilities) && capabilities.length > 0
        ? capabilities
        : ["accessibility", "screen_recording"];
    const status = {};
    for (const capability of requested) {
      status[capability] = (await probePermission(xa11y, capability)).state;
    }
    return { ready: Object.values(status).every((state) => state === "granted"), status };
  };
}

function createPasteAdapter(xa11y) {
  return async ({ text }) => {
    const simulator = xa11y.inputSim?.();
    if (!simulator || typeof simulator.typeText !== "function") {
      throw new CuaHelperError("xa11y input simulator is unavailable.", {
        code: "broker_unavailable",
      });
    }
    // xa11y 没有跨平台剪贴板 API；直接注入同一文本可避免覆盖用户剪贴板，同时保留
    // `paste` 的可观察结果。富文本格式降级为文本是开源 Helper 的明确兼容语义。
    await simulator.typeText(text);
    await simulator.dispose?.();
  };
}
export { probePermission, createPermissionAdapter, createPasteAdapter };
