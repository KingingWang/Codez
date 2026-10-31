// 原 producer factory 保留 native single-flight、maps、输入位置和销毁状态。
import { randomUUID as createRandomUUID } from "node:crypto";
import { executeMotionPath } from "./motion-profile.js";
import {
  METHOD_NAMES,
  TREE_UNAVAILABLE_REASON,
  producerError,
  normalizeMotionOptions,
  requirePlainObject,
  requireExactKeys,
  parseParams,
  parseContext,
} from "./producer/protocol.js";
import {
  readProperty,
  canonicalAppRef,
  mapXa11yError,
  captureElementTree,
  diffElements,
  renderStateText,
  sessionMaps,
} from "./producer/observation.js";
import { createProducerAppResolver } from "./producer/app-resolver.js";
export { XA11Y_PRODUCER_METHODS, Xa11yProducerError } from "./producer/protocol.js";

async function defaultLoadXa11y() {
  const imported = await import("@crowecawcaw/xa11y");
  // xa11y 0.15.0 是 CommonJS；Node ESM 的具名导出探测不会暴露 inputSim/screenshot。
  // 必须优先读 default，否则真机只看到 App 而动作与截图在运行期才报 undefined。
  return imported.default ?? imported;
}

export function createXa11yProducer(options = {}) {
  const loadXa11y = options.loadXa11y ?? defaultLoadXa11y;
  const platform = options.platform ?? process.platform;
  const makeId = options.randomUUID ?? createRandomUUID;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxElements =
    Number.isSafeInteger(options.maxElements) && options.maxElements > 0
      ? options.maxElements
      : 10_000;
  const motion = normalizeMotionOptions(options);
  const launcher = options.launcher;
  const launchPollAttempts = options.launchPollAttempts ?? 40;
  const launchPollIntervalMs = options.launchPollIntervalMs ?? 250;
  if (
    !Number.isSafeInteger(launchPollAttempts) ||
    launchPollAttempts < 1 ||
    launchPollAttempts > 200
  ) {
    throw producerError("INVALID_REQUEST", "launch poll attempts must be between 1 and 200");
  }
  if (
    !Number.isSafeInteger(launchPollIntervalMs) ||
    launchPollIntervalMs < 0 ||
    launchPollIntervalMs > 5_000
  ) {
    throw producerError("INVALID_REQUEST", "launch poll interval must be between 0 and 5000 ms");
  }
  const snapshots = new Map();
  const baselines = new Map();
  const launchAttempts = new Map();
  const lifecycle = new AbortController();
  let modulePromise;
  let inputSimPromise;
  let lastPointerPoint;
  let disposed = false;

  async function xa11y() {
    modulePromise ??= Promise.resolve().then(loadXa11y);
    let loaded;
    try {
      loaded = await modulePromise;
    } catch (error) {
      modulePromise = undefined;
      throw mapXa11yError(error, "HELPER_UNAVAILABLE");
    }
    if (!loaded?.App || typeof loaded.App.list !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "xa11y App API is unavailable");
    }
    return loaded;
  }

  async function inputSim() {
    inputSimPromise ??= xa11y().then((module) => {
      if (typeof module.inputSim !== "function") {
        throw producerError("HELPER_UNAVAILABLE", "xa11y inputSim API is unavailable");
      }
      return module.inputSim();
    });
    try {
      return await inputSimPromise;
    } catch (error) {
      inputSimPromise = undefined;
      throw mapXa11yError(error, "HELPER_UNAVAILABLE");
    }
  }

  const { resolveAppAndWindow, listApps, listWindows } = createProducerAppResolver({
    options,
    platform,
    launcher,
    launchPollAttempts,
    launchPollIntervalMs,
    lifecycle,
    launchAttempts,
    xa11y,
    delay,
    isDisposed: () => disposed,
  });

  async function captureScreenshot(module, windowHandle) {
    if (typeof module.screenshot !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "xa11y screenshot API is unavailable");
    }
    const shot = await module.screenshot({ element: windowHandle });
    const width = readProperty(shot, "width");
    const height = readProperty(shot, "height");
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new Error("xa11y screenshot dimensions are invalid");
    }
    const png = shot.toPng();
    if (!Buffer.isBuffer(png)) throw new Error("xa11y screenshot PNG is invalid");
    return { shot, width, height, png };
  }

  async function getAppState(params, context) {
    const resolved = await resolveAppAndWindow(params.appRef, true);
    const tree = await captureElementTree(resolved.window.handle, maxElements);
    const entries = tree.entries;
    const treeUnavailable = tree.treeUnavailable;
    const sessionSnapshots = sessionMaps(snapshots, context.key);
    const previousSnapshot = sessionSnapshots.get(resolved.targetKey);
    let frame = params.includeScreenshot ? undefined : previousSnapshot?.frame;
    let screenshot;
    let nonActionableReason;
    if (params.includeScreenshot) {
      try {
        const captured = await captureScreenshot(await xa11y(), resolved.window.handle);
        frame = {
          ...captured,
          frameId: makeId(),
          mappingAvailable: readProperty(captured.shot, "mappingAvailable", false) === true,
        };
        screenshot = {
          data: captured.png.toString("base64"),
          mime_type: "image/png",
          width: captured.width,
          height: captured.height,
          frame_id: frame.frameId,
        };
        if (!frame.mappingAvailable)
          nonActionableReason = "screenshot_coordinate_mapping_unavailable";
      } catch (error) {
        frame = undefined;
        nonActionableReason = `screenshot_unavailable:${error instanceof Error ? error.name : "Error"}`;
      }
    }

    // 只有当前观察同时拿到可映射 PNG，树降级才允许继续；否则维持结构化失败，避免把
    // 没有可操作坐标的半棵树误交给模型。include_screenshot=false 也不能借用旧帧绕过此门。
    if (treeUnavailable && (!params.includeScreenshot || !frame?.mappingAvailable)) {
      throw producerError(
        "STRUCTURED_STATE_UNAVAILABLE",
        "accessibility tree is unavailable and no actionable screenshot is available",
      );
    }

    const stateId = makeId();
    const app = { ...resolved.app.record };
    const window = { ...resolved.window.record };
    const sessionBaselines = sessionMaps(baselines, context.key);
    const baseline = resolved.windowIdentityStable
      ? sessionBaselines.get(resolved.targetKey)
      : undefined;
    if (treeUnavailable) sessionBaselines.delete(resolved.targetKey);
    const full = params.disableDiffing || !baseline || treeUnavailable;
    const changes = full ? undefined : diffElements(baseline.entries, entries);
    const snapshot = {
      stateId,
      targetKey: resolved.targetKey,
      app,
      window,
      appRef: canonicalAppRef(app, window),
      appHandle: resolved.app.handle,
      windowHandle: resolved.window.handle,
      windowIdentityStable: resolved.windowIdentityStable,
      entries,
      frame,
      treeUnavailable,
    };
    sessionSnapshots.set(resolved.targetKey, snapshot);
    if (params.treeShownToModel && resolved.windowIdentityStable && !treeUnavailable) {
      sessionBaselines.set(resolved.targetKey, snapshot);
    }

    const result = {
      state_id: stateId,
      mode: full ? "full" : "incremental",
      base_state_id: full ? null : baseline.stateId,
      app,
      window,
      focused_element: entries.find((entry) => entry.row.focused)?.row.index ?? null,
      elements: entries.map((entry) => ({ ...entry.row })),
      text: renderStateText(app, window, stateId, entries, changes, treeUnavailable),
      ...(changes ? { changes } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(frame ? { frame_id: frame.frameId } : {}),
      ...(treeUnavailable ? { tree_unavailable_reason: TREE_UNAVAILABLE_REASON } : {}),
      ...(nonActionableReason ? { non_actionable_reason: nonActionableReason } : {}),
    };
    return result;
  }

  async function snapshotFor(appRef, context) {
    const sessionSnapshots = snapshots.get(context.key);
    if (!sessionSnapshots || sessionSnapshots.size === 0) {
      throw producerError("ELEMENT_UNAVAILABLE", "session has no accessibility snapshot", {
        retry: "reobserve",
      });
    }
    if (appRef) {
      const resolved = await resolveAppAndWindow(appRef);
      const snapshot = sessionSnapshots.get(resolved.targetKey);
      if (!snapshot) {
        throw producerError("STALE_STATE", "latest app/window snapshot is unavailable", {
          retry: "reobserve",
        });
      }
      if (!snapshot.windowIdentityStable || !resolved.windowIdentityStable) {
        throw producerError("STALE_STATE", "window identity cannot be revalidated", {
          retry: "reobserve",
        });
      }
      return { snapshot, resolved };
    }
    if (sessionSnapshots.size !== 1) {
      throw producerError("ELEMENT_UNAVAILABLE", "target snapshot is ambiguous", {
        retry: "reobserve",
      });
    }
    const snapshot = sessionSnapshots.values().next().value;
    const resolved = await resolveAppAndWindow(snapshot.appRef);
    if (
      resolved.targetKey !== snapshot.targetKey ||
      !snapshot.windowIdentityStable ||
      !resolved.windowIdentityStable
    ) {
      throw producerError("STALE_STATE", "target window changed after observation", {
        retry: "reobserve",
      });
    }
    return { snapshot, resolved };
  }

  async function resolveTarget(target, appRef, context) {
    const { snapshot, resolved } = await snapshotFor(appRef, context);
    if (target.type === "element") {
      if (snapshot.treeUnavailable) {
        throw producerError("ELEMENT_UNAVAILABLE", "accessibility tree is incomplete", {
          retry: "reobserve",
        });
      }
      const entry = snapshot.entries[target.index];
      if (!entry || entry.row.index !== target.index) {
        throw producerError("ELEMENT_UNAVAILABLE", "element index is unknown or stale", {
          retry: "reobserve",
        });
      }
      return { kind: "element", nativeTarget: entry.handle, entry, snapshot, resolved };
    }
    const frame = snapshot.frame;
    if (!frame || !frame.mappingAvailable || typeof frame.shot?.imageToDesktop !== "function") {
      throw producerError("STALE_STATE", "coordinate target has no actionable raster", {
        retry: "reobserve",
      });
    }
    if (target.frameId !== undefined && target.frameId !== frame.frameId) {
      throw producerError("STALE_STATE", "coordinate frame_id is stale", { retry: "reobserve" });
    }
    if (target.x >= frame.width || target.y >= frame.height) {
      throw producerError("INVALID_REQUEST", "coordinate is outside the referenced raster");
    }
    const desktop = frame.shot.imageToDesktop(target.x, target.y);
    if (
      !Array.isArray(desktop) ||
      desktop.length !== 2 ||
      desktop.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    ) {
      throw producerError("STALE_STATE", "xa11y coordinate mapping failed", {
        retry: "reobserve",
      });
    }
    return { kind: "coordinate", nativeTarget: desktop, snapshot, resolved };
  }

  async function ensureForeground(resolved, appRef) {
    let appActive = resolved.app.record.active;
    let windowFocused = resolved.window.record.focused;
    if (platform === "win32" && typeof options.discoverApps === "function") {
      try {
        // PID app_ref 会绕过应用发现以避免 UIA 全桌面枚举；输入前再用同一 Win32
        // EnumWindows/GetForegroundWindow 事实做一次轻量安全复核，不能退回 UIA active 字段。
        const apps = await options.discoverApps({ signal: lifecycle.signal });
        const discoveredApp = apps.find((app) => app?.pid === resolved.app.record.pid);
        appActive = discoveredApp?.active === true;
        if (appRef?.window_id !== undefined) {
          const discoveredWindow = discoveredApp?.windows?.find(
            (window) => window?.window_id === resolved.window.record.window_id,
          );
          windowFocused = discoveredWindow?.focused === true;
        }
      } catch (error) {
        throw mapXa11yError(error, "INTERNAL");
      }
    }
    if (!appActive) {
      throw producerError(
        "FOREGROUND_REQUIRED",
        "event input requires the target app to be foreground",
      );
    }
    if (appRef?.window_id !== undefined && !windowFocused) {
      throw producerError(
        "FOREGROUND_REQUIRED",
        "event input requires the target window to be focused",
      );
    }
  }

  async function invokeAction(work, fallbackCode = "INTERNAL") {
    try {
      await work();
    } catch (error) {
      throw mapXa11yError(error, fallbackCode, true);
    }
  }

  async function moveAlongConfiguredPath(sim, from, to) {
    await executeMotionPath(
      {
        async moveTo(point) {
          await sim.moveTo(point);
          lastPointerPoint = [point[0], point[1]];
        },
      },
      from,
      to,
      { ...motion, sleep: delay },
    );
  }

  async function prepareCoordinatePointer(sim, target, forceUnknownMove = false) {
    if (target.kind !== "coordinate") {
      lastPointerPoint = undefined;
      return;
    }
    const destination = [target.nativeTarget[0], target.nativeTarget[1]];
    if (motion.profile === "smooth" && lastPointerPoint) {
      await moveAlongConfiguredPath(sim, lastPointerPoint, destination);
    } else if (motion.profile === "smooth" && forceUnknownMove) {
      await sim.moveTo(destination);
      lastPointerPoint = destination;
    }
  }

  function rememberCoordinateTarget(target) {
    lastPointerPoint =
      target.kind === "coordinate" ? [target.nativeTarget[0], target.nativeTarget[1]] : undefined;
  }

  async function completeAction(params, context, targetResolution) {
    if (params.returnState === "none") return { action_sent: true };
    const appRef = params.appRef ?? targetResolution?.snapshot.appRef;
    if (!appRef || Object.keys(appRef).length === 0) {
      throw producerError("INVALID_APP", "return_state requires an app reference", {
        actionSent: true,
        retry: "reobserve",
      });
    }
    let state;
    try {
      state = await getAppState(
        {
          appRef,
          includeScreenshot: false,
          disableDiffing: params.returnState === "full",
          treeShownToModel: true,
        },
        context,
      );
    } catch (error) {
      // 动作已经完成后，随调用返回的观察失败不能把 actionSent 重新写成 false。
      const mapped = mapXa11yError(error, "INTERNAL", true);
      mapped.actionSent = true;
      mapped.retry = "reobserve";
      throw mapped;
    }
    return { action_sent: true, state };
  }

  async function click(params, context) {
    const target = await resolveTarget(params.target, params.appRef, context);
    const canPress =
      target.kind === "element" &&
      params.mouseButton === "left" &&
      params.clickCount === 1 &&
      params.modifiers.length === 0 &&
      target.entry.row.actions.includes("press");
    if (params.strategy === "a11y" || (params.strategy === "auto" && canPress)) {
      if (!canPress)
        throw producerError("ACTION_UNAVAILABLE", "element has no compatible press action");
      await invokeAction(() => target.nativeTarget.press(), "ACTION_UNAVAILABLE");
    } else {
      await ensureForeground(target.resolved, params.appRef);
      const sim = await inputSim();
      await invokeAction(async () => {
        await prepareCoordinatePointer(sim, target);
        await sim.click(target.nativeTarget, {
          button: params.mouseButton,
          count: params.clickCount,
          held: params.modifiers,
        });
        rememberCoordinateTarget(target);
      });
    }
    return completeAction(params, context, target);
  }

  async function drag(params, context) {
    const from = await resolveTarget(params.fromTarget, params.appRef, context);
    const to = await resolveTarget(params.toTarget, params.appRef, context);
    if (from.snapshot.stateId !== to.snapshot.stateId) {
      throw producerError("STALE_STATE", "drag endpoints belong to different snapshots", {
        retry: "reobserve",
      });
    }
    await ensureForeground(from.resolved, params.appRef);
    const sim = await inputSim();
    await invokeAction(async () => {
      if (motion.profile !== "smooth" || from.kind !== "coordinate" || to.kind !== "coordinate") {
        await sim.drag(from.nativeTarget, to.nativeTarget, { held: params.modifiers });
        rememberCoordinateTarget(to);
        return;
      }
      // Bug 根因：轨迹模块此前没有任何产品调用点，打包后的 Helper 永远只走 xa11y 默认拖拽。
      // 坐标拖拽在同一 inputSim owner 内显式按下/移动/释放，异常时也必须释放按键和鼠标。
      await prepareCoordinatePointer(sim, from, true);
      const held = [];
      let mousePressed = false;
      let failure;
      try {
        for (const modifier of params.modifiers) {
          await sim.keyDown(modifier);
          held.push(modifier);
        }
        await sim.mouseDown("left");
        mousePressed = true;
        await moveAlongConfiguredPath(sim, from.nativeTarget, to.nativeTarget);
      } catch (error) {
        failure = error;
      }
      if (mousePressed) {
        try {
          await sim.mouseUp("left");
        } catch (error) {
          failure ??= error;
        }
      }
      for (const modifier of held.toReversed()) {
        try {
          await sim.keyUp(modifier);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
      rememberCoordinateTarget(to);
    });
    return completeAction(params, context, from);
  }

  function scrollDelta(target, direction, amount) {
    const bounds = target.snapshot.window.bounds;
    if (!Array.isArray(bounds)) {
      throw producerError("ACTION_UNAVAILABLE", "window bounds are unavailable for page scrolling");
    }
    const distance = Math.round(
      (direction === "up" || direction === "down" ? bounds[3] : bounds[2]) * amount,
    );
    if (direction === "up") return [0, -distance];
    if (direction === "down") return [0, distance];
    if (direction === "left") return [-distance, 0];
    return [distance, 0];
  }

  async function scroll(params, context) {
    const target = await resolveTarget(params.target, params.appRef, context);
    const action = `scroll_${params.direction}`;
    const canUseSemantic = target.kind === "element" && target.entry.row.actions.includes(action);
    if (params.strategy === "a11y" || (params.strategy === "auto" && canUseSemantic)) {
      if (!canUseSemantic) {
        throw producerError("ACTION_UNAVAILABLE", `element does not advertise ${action}`);
      }
      for (let count = 0; count < Math.ceil(params.amount); count += 1) {
        await invokeAction(() => target.nativeTarget.performAction(action), "ACTION_UNAVAILABLE");
      }
    } else if (params.amount > 0) {
      await ensureForeground(target.resolved, params.appRef);
      const [dx, dy] = scrollDelta(target, params.direction, params.amount);
      const sim = await inputSim();
      await invokeAction(async () => {
        await prepareCoordinatePointer(sim, target);
        await sim.scroll(target.nativeTarget, dx, dy);
        rememberCoordinateTarget(target);
      });
    }
    return completeAction(params, context, target);
  }

  async function typeText(params, context) {
    let target;
    if (params.target) target = await resolveTarget(params.target, params.appRef, context);
    const canUseSemantic =
      target?.kind === "element" && typeof target.nativeTarget.typeText === "function";
    if (params.strategy === "a11y" || (params.strategy === "auto" && canUseSemantic)) {
      if (!canUseSemantic)
        throw producerError(
          "ACTION_UNAVAILABLE",
          "type requires an element target for a11y strategy",
        );
      await invokeAction(() => target.nativeTarget.typeText(params.text), "ACTION_UNAVAILABLE");
    } else {
      let resolved = target?.resolved;
      if (!resolved && params.appRef) resolved = await resolveAppAndWindow(params.appRef);
      if (!resolved) throw producerError("INVALID_APP", "event typing requires app_ref or target");
      await ensureForeground(resolved, params.appRef);
      const sim = await inputSim();
      if (target) {
        if (target.kind === "element")
          await invokeAction(() => target.nativeTarget.focus(), "ACTION_UNAVAILABLE");
        else {
          await invokeAction(async () => {
            await prepareCoordinatePointer(sim, target);
            await sim.click(target.nativeTarget);
            rememberCoordinateTarget(target);
          });
        }
      }
      await invokeAction(() => sim.typeText(params.text));
    }
    return completeAction(params, context, target);
  }

  async function semanticElementAction(params, context, action) {
    if (params.target.type !== "element") {
      throw producerError("ACTION_UNAVAILABLE", `${action} requires an element target`);
    }
    const target = await resolveTarget(params.target, params.appRef, context);
    if (params.strategy === "event") {
      throw producerError("ACTION_UNAVAILABLE", `${action} has no event fallback`);
    }
    if (action === "set_value") {
      await invokeAction(() => target.nativeTarget.setValue(params.value), "NOT_SETTABLE");
    } else if (action === "select_text") {
      const value = target.entry.row.value;
      if (params.textRange === undefined && value === null) {
        throw producerError("NOT_SELECTABLE", "element has no text value");
      }
      const [start, length] = params.textRange ?? [0, value.length];
      await invokeAction(
        () => target.nativeTarget.selectText(start, start + length),
        "NOT_SELECTABLE",
      );
    }
    return completeAction(params, context, target);
  }

  async function key(params, context) {
    if (params.strategy === "a11y") {
      throw producerError("ACTION_UNAVAILABLE", "key has no generic accessibility action");
    }
    let resolved;
    let targetResolution;
    if (params.appRef) resolved = await resolveAppAndWindow(params.appRef);
    else {
      targetResolution = await snapshotFor(undefined, context);
      resolved = targetResolution.resolved;
    }
    await ensureForeground(resolved, params.appRef);
    const sim = await inputSim();
    for (let count = 0; count < params.repeat; count += 1) {
      if (params.holdSeconds > 0) {
        const pressed = [];
        let failure;
        try {
          for (const held of params.chord.held) {
            await invokeAction(() => sim.keyDown(held));
            pressed.push(held);
          }
          await invokeAction(() => sim.keyDown(params.chord.key));
          pressed.push(params.chord.key);
          await delay(params.holdSeconds * 1000);
        } catch (error) {
          failure = error;
        }
        // keyDown 或首个 keyUp 失败也必须继续释放已按下键，避免把系统留在 Ctrl/Meta 按住状态。
        for (const pressedKey of pressed.toReversed()) {
          try {
            await invokeAction(() => sim.keyUp(pressedKey));
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      } else if (params.chord.held.length > 0) {
        await invokeAction(() => sim.chord(params.chord.key, params.chord.held));
      } else {
        await invokeAction(() => sim.press(params.chord.key));
      }
    }
    return completeAction(params, context, targetResolution);
  }

  async function paste(params, context) {
    if (typeof options.paste !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "Helper clipboard paste adapter is unavailable");
    }
    let resolved;
    let targetResolution;
    if (params.appRef) resolved = await resolveAppAndWindow(params.appRef);
    else {
      targetResolution = await snapshotFor(undefined, context);
      resolved = targetResolution.resolved;
    }
    await ensureForeground(resolved, params.appRef);
    await invokeAction(
      () => options.paste({ text: params.text, format: params.format, context: context.raw }),
      "INTERNAL",
    );
    return completeAction(params, context, targetResolution);
  }

  async function performAction(params, context) {
    if (params.target.type !== "element") {
      throw producerError("ACTION_UNAVAILABLE", "perform_action requires an element target");
    }
    const target = await resolveTarget(params.target, params.appRef, context);
    if (!target.entry.row.actions.includes(params.action)) {
      throw producerError("ACTION_UNAVAILABLE", "element does not advertise the requested action");
    }
    await invokeAction(
      () => target.nativeTarget.performAction(params.action),
      "ACTION_UNAVAILABLE",
    );
    return completeAction(params, context, target);
  }

  function clearSession(context) {
    snapshots.delete(context.key);
    baselines.delete(context.key);
  }

  async function dispatchValidated(method, params, context) {
    switch (method) {
      case "list_apps":
        return listApps();
      case "list_windows":
        return listWindows(params);
      case "get_app_state":
        return getAppState(params, context);
      case "left_click":
        return click(params, context);
      case "left_click_drag":
        return drag(params, context);
      case "scroll":
        return scroll(params, context);
      case "type":
        return typeText(params, context);
      case "set_value":
        return semanticElementAction(params, context, "set_value");
      case "select_text":
        return semanticElementAction(params, context, "select_text");
      case "key":
        return key(params, context);
      case "paste":
        return paste(params, context);
      case "perform_action":
        return performAction(params, context);
      case "request_access":
        if (typeof options.requestAccess !== "function") {
          throw producerError("HELPER_UNAVAILABLE", "Helper permission adapter is unavailable");
        }
        try {
          return await options.requestAccess({
            capabilities: params.capabilities,
            context: context.raw,
          });
        } catch (error) {
          throw mapXa11yError(error, "INTERNAL");
        }
      case "stop_computer_control":
        clearSession(context);
        try {
          await options.stop?.({ reason: params.reason, context: context.raw });
        } catch (error) {
          throw mapXa11yError(error, "INTERNAL");
        }
        return { stopped: true };
      default:
        throw producerError("INVALID_REQUEST", "unknown Computer Use method");
    }
  }

  async function dispatch(method, rawParams, rawContext) {
    if (disposed) throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
    if (typeof method !== "string" || !METHOD_NAMES.has(method)) {
      throw producerError("INVALID_REQUEST", "unknown Computer Use method");
    }
    // 参数与 owner context 必须在 native import、权限提示或输入副作用之前完成校验。
    const params = parseParams(method, rawParams);
    const context = parseContext(rawContext);
    try {
      const result = await dispatchValidated(method, params, context);
      if (!disposed) return result;
    } catch (error) {
      if (!disposed) throw error;
    }
    // Bug 根因：dispose 可能发生在 xa11y 的 App.list/tree/screenshot await 内；旧实现会在
    // 清理完成后继续写回 snapshot 并成功返回。最后一道生命周期栅栏统一拒绝晚完成。
    snapshots.clear();
    baselines.clear();
    throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
  }

  return {
    dispatch,
    execute(input) {
      const request = requirePlainObject(input, "input");
      requireExactKeys(request, ["method", "params", "context"], "input");
      return dispatch(request.method, request.params, request.context);
    },
    async closeSession(rawContext) {
      if (disposed) return;
      clearSession(parseContext(rawContext));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort();
      snapshots.clear();
      baselines.clear();
      const sim = await inputSimPromise?.catch(() => undefined);
      await Promise.allSettled([sim?.dispose?.(), launcher?.dispose?.()]);
    },
  };
}
