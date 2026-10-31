// 无新增 cache 或 lifecycle；通过端口使用原 factory 的 launchAttempts/abort/disposed。
import { normalizeInstalledAppLookupKey } from "../installed-app-launcher.js";
import { Xa11yProducerError, producerError } from "./protocol.js";
import {
  appRecord,
  windowRecord,
  matchesAppRef,
  matchesLaunchedApp,
  internalWindowIdentity,
  mapXa11yError,
} from "./observation.js";

export function createProducerAppResolver({
  options,
  platform,
  launcher,
  launchPollAttempts,
  launchPollIntervalMs,
  lifecycle,
  launchAttempts,
  xa11y,
  delay,
  isDisposed,
}) {
  async function listAppHandles() {
    try {
      if (options.discoverApps) {
        const apps = await options.discoverApps({ signal: lifecycle.signal });
        return apps.map(({ windows, ...record }) => ({
          record,
          discoveredWindows: windows,
        }));
      }
      const apps = await (await xa11y()).App.list();
      if (!Array.isArray(apps)) throw new Error("xa11y App.list() returned invalid data");
      return apps.map((handle) => ({ handle, record: appRecord(handle) }));
    } catch (error) {
      throw mapXa11yError(error, "INTERNAL");
    }
  }

  function resolveUniqueApp(matches) {
    if (matches.length === 0) {
      throw producerError("APP_NOT_FOUND", "application reference did not match a running app", {
        retry: "reobserve",
      });
    }
    if (matches.length !== 1) {
      throw producerError("AMBIGUOUS_APP", "application reference matched more than one app", {
        retry: "never",
      });
    }
    return matches[0];
  }

  function canLaunch(ref) {
    return (
      launcher &&
      ref.pid === undefined &&
      ref.window_id === undefined &&
      (ref.name !== undefined || ref.bundle_id !== undefined)
    );
  }

  function mapLauncherError(error) {
    if (error instanceof Xa11yProducerError) return error;
    const code = error?.code;
    if (
      code === "APP_NOT_FOUND" ||
      code === "AMBIGUOUS_APP" ||
      code === "LAUNCH_FAILED" ||
      code === "CONTROL_STOPPED"
    ) {
      return producerError(code, error.message || "installed application launch failed", {
        details: error.details,
        retry: code === "CONTROL_STOPPED" ? "never" : "reobserve",
      });
    }
    return producerError("LAUNCH_FAILED", "installed application launch failed", {
      retry: "reobserve",
    });
  }

  async function waitForLaunchPoll() {
    if (isDisposed() || lifecycle.signal.aborted) {
      throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
    }
    await new Promise((resolve, reject) => {
      const abort = () => {
        reject(producerError("CONTROL_STOPPED", "xa11y producer is disposed"));
      };
      lifecycle.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => delay(launchPollIntervalMs))
        .then(resolve, reject)
        .finally(() => lifecycle.signal.removeEventListener("abort", abort));
    });
  }

  async function launchAndWaitForApp(ref) {
    if (isDisposed()) throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
    let installed;
    try {
      installed = await launcher.launch(ref);
    } catch (error) {
      throw mapLauncherError(error);
    }
    for (let attempt = 0; attempt < launchPollAttempts; attempt += 1) {
      if (isDisposed()) throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
      // Bug 根因：launcher 已唯一解析出安装身份后，旧代码仍用用户原始别名做严格相等，
      // 启动成功的 QQScLauncher/QQ 等名称差异会一直轮询到 APP_NOT_READY。
      const matches = (await listAppHandles()).filter(({ record }) =>
        matchesLaunchedApp(record, ref, installed, platform),
      );
      if (matches.length === 1) {
        const windows = await listWindowHandles(matches[0]);
        if (selectWindow(windows, ref)) return matches[0];
      }
      if (matches.length > 1) resolveUniqueApp(matches);
      if (attempt + 1 < launchPollAttempts) await waitForLaunchPoll();
    }
    throw producerError("APP_NOT_READY", "launched application is not ready for observation", {
      retry: "retry",
    });
  }

  async function ensureLaunchedApp(ref) {
    const key = normalizeInstalledAppLookupKey(ref, platform);
    let attempt = launchAttempts.get(key);
    if (!attempt) {
      // Bug 根因：producer 过去把“未运行”和“未安装”都直接判为 APP_NOT_FOUND，SDK 的
      // getApp 因而永远不会启动桌面应用。启动 promise 由 producer 唯一持有，避免并发重复副作用。
      attempt = launchAndWaitForApp(ref).finally(() => {
        if (launchAttempts.get(key) === attempt) launchAttempts.delete(key);
      });
      launchAttempts.set(key, attempt);
    }
    return attempt;
  }

  async function resolveApp(ref, allowLaunch = false) {
    if (platform === "win32" && ref.pid !== undefined) {
      // 已有 PID 时不再先做全桌面 App.list；否则一个无关窗口超时也会阻断已知目标。
      const handle = await attachAppByPid(ref.pid);
      const app = { handle, record: appRecord(handle) };
      return resolveUniqueApp(matchesAppRef(app.record, ref) ? [app] : []);
    }
    const apps = await listAppHandles();
    const matches = apps.filter(({ record }) => matchesAppRef(record, ref));
    if (matches.length > 0 || !allowLaunch) return resolveUniqueApp(matches);

    // Bug 根因：Windows live app 名仅含通用 launcher 后缀时，严格查询会把“已运行”
    // 误判成“未运行”并产生第二次启动副作用。先按平台规则做唯一 live 复核。
    const normalizedMatches = apps.filter(({ record }) =>
      matchesLaunchedApp(record, ref, undefined, platform),
    );
    if (normalizedMatches.length > 0) return resolveUniqueApp(normalizedMatches);
    if (allowLaunch) {
      const titleMatches = await findAppsByWindowTitle(apps, ref);
      if (titleMatches.length > 0) {
        // Bug 根因：微信等自绘应用的进程名（Weixin）与窗口标题（微信）可本地化不同，
        // 且 Start Apps 可能把同名 UWP 入口列在前面。窗口标题是当前 live app 的事实，
        // 唯一命中时应直接绑定，不能因为安装项名称不一致再次启动。
        return resolveUniqueApp(titleMatches);
      }
    }
    if (!canLaunch(ref)) return resolveUniqueApp(normalizedMatches);
    if (allowLaunch) {
      if (typeof launcher.resolve === "function") {
        try {
          // 仅在窗口标题没有唯一命中时解析安装身份；若安装项本身也未映射到 live app，
          // 下面的 launchAndWaitForApp 会以同一身份有界启动，不凭猜测绑定其它进程。
          const installed = await launcher.resolve(ref);
          const running = apps.filter(({ record }) =>
            matchesLaunchedApp(record, ref, installed, platform),
          );
          if (running.length > 0) return resolveUniqueApp(running);
        } catch (error) {
          if (error?.code !== "APP_NOT_FOUND") throw mapLauncherError(error);
        }
      }
      return await ensureLaunchedApp(ref);
    }
    return resolveUniqueApp(normalizedMatches);
  }

  async function listWindowHandles(app) {
    try {
      app.handle ??= await attachAppByPid(app.record.pid);
      if (!app.discoveredWindows) {
        // 非 Windows 平台没有 Win32 发现记录，沿用 xa11y 的原生前台事实。
        app.record.active = appRecord(app.handle).active;
      }
      const windows = await app.handle.windows();
      if (!Array.isArray(windows)) throw new Error("xa11y App.windows() returned invalid data");
      const discoveredWindows = new Map(
        (app.discoveredWindows ?? [])
          .filter((window) => Number.isSafeInteger(window?.window_id))
          .map((window) => [window.window_id, window]),
      );
      return windows.map((handle, index) => {
        const record = windowRecord(handle, index);
        const discovered = discoveredWindows.get(record.window_id);
        if (discovered !== undefined) {
          // Bug 根因：Windows UIA 的 Window.active/isForeground 与 GetForegroundWindow
          // 不是同一事实源，绑定后用 UIA 覆盖会把真实前台窗口误判成
          // foreground_required；输入门必须复用同一次 Win32 HWND/PID 发现结果。
          record.focused = discovered.focused;
        }
        return { handle, record };
      });
    } catch (error) {
      throw mapXa11yError(error, "INTERNAL");
    }
  }

  async function attachAppByPid(pid) {
    try {
      const module = await xa11y();
      if (typeof module.App.byPid !== "function") {
        throw producerError("HELPER_UNAVAILABLE", "xa11y App.byPid API is unavailable");
      }
      const handle = await module.App.byPid(pid, { timeout: 0 });
      if (appRecord(handle).pid !== pid) {
        throw producerError("INVALID_APP", "target app process identity changed");
      }
      return handle;
    } catch (error) {
      throw mapXa11yError(error, "INTERNAL");
    }
  }

  async function findAppsByWindowTitle(apps, ref) {
    if (ref.name === undefined) return [];
    const matches = [];
    for (const app of apps) {
      if (app.discoveredWindows) {
        if (app.discoveredWindows.some((window) => window.title === ref.name)) matches.push(app);
        continue;
      }
      try {
        const windows = await listWindowHandles(app);
        if (windows.some(({ record }) => record.title === ref.name)) matches.push(app);
      } catch {
        // 窗口枚举失败不应把一个可通过 launcher 解析的应用误报成内部错误；
        // 后续仍会走安装身份解析与有界启动路径。
      }
    }
    return matches;
  }

  function selectWindow(windows, ref) {
    if (ref.window_id !== undefined) {
      const matches = windows.filter(({ record }) => record.window_id === ref.window_id);
      return matches.length === 1
        ? { window: matches[0], selection: `window:${ref.window_id}` }
        : undefined;
    }
    // Bug 根因：本地化 app_ref 可能与进程名不同，同一进程又有聊天窗/媒体窗；先用唯一
    // 精确标题绑定，不能让另一个恰好 focused/main 的兄弟窗抢走目标。
    const titled =
      ref.name === undefined ? [] : windows.filter(({ record }) => record.title === ref.name);
    if (titled.length === 1) return { window: titled[0], selection: "title" };
    const focused = windows.filter(({ record }) => record.focused);
    const main = windows.filter(({ record }) => record.main === true);
    if (focused.length === 1) return { window: focused[0], selection: "focused" };
    if (main.length === 1) return { window: main[0], selection: "main" };
    return windows.length === 1 ? { window: windows[0], selection: "sole" } : undefined;
  }

  async function resolveAppAndWindow(ref, allowLaunch = false) {
    const app = await resolveApp(ref, allowLaunch);
    const windows = await listWindowHandles(app);
    const selected = selectWindow(windows, ref);
    if (!selected) {
      throw producerError("STALE_STATE", "target window is unavailable or ambiguous", {
        retry: "reobserve",
      });
    }
    const { window, selection } = selected;
    const stableIdentity = internalWindowIdentity(window.handle, window.record);
    const pid = app.record.pid;
    if (pid === null) {
      throw producerError("INVALID_APP", "target app has no process identity");
    }
    // 平台未给 stableId/window_id 时仍允许读取树并返回 window_id:null；内部 selection key
    // 只用于保存本次观察，绝不冒充可回传的窗口身份。此类 snapshot 的动作会在复核时拒绝。
    const identity = stableIdentity ?? `selection:${selection}`;
    return {
      app,
      window,
      targetKey: `${pid}\u0000${identity}`,
      windowIdentityStable: stableIdentity !== null,
    };
  }

  async function listApps() {
    return (await listAppHandles()).map(({ record }) => ({ ...record }));
  }

  async function listWindows(params) {
    const app = await resolveApp(params.appRef);
    let windows = await listWindowHandles(app);
    if (params.appRef.window_id !== undefined) {
      windows = windows.filter(({ record }) => record.window_id === params.appRef.window_id);
      if (windows.length !== 1) {
        throw producerError("STALE_STATE", "window_id did not resolve uniquely", {
          retry: "reobserve",
        });
      }
    }
    return windows.map(({ record }) => ({ ...record }));
  }
  return { resolveAppAndWindow, listApps, listWindows };
}
