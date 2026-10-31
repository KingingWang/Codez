// 原 native 属性读取、元素树与结果投影；maps 仍由 producer factory 持有。
import { normalizeInstalledAppName } from "../installed-app-launcher.js";
import { isXa11yPermissionDenied, isXa11yTimeout } from "../xa11y-errors.js";
// 树降级原因与主 producer 共用协议常量，拆分不改变 frame 投影语义。
import {
  RAW_BUNDLE_ID_KEYS,
  RAW_WINDOW_ID_KEYS,
  TREE_UNAVAILABLE_REASON,
  Xa11yProducerError,
  producerError,
  isPlainObject,
} from "./protocol.js";

function readProperty(value, key, fallback = null) {
  try {
    return value?.[key] ?? fallback;
  } catch {
    return fallback;
  }
}

function readRaw(value) {
  const raw = readProperty(value, "raw", {});
  return isPlainObject(raw) ? raw : {};
}

function readExplicitString(raw, keys) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readWindowId(window) {
  const raw = readRaw(window);
  for (const key of RAW_WINDOW_ID_KEYS) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) return raw[key];
  }
  const stableId = readProperty(window, "stableId");
  if (typeof stableId === "string" && /^(?:0|[1-9]\d*)$/u.test(stableId)) {
    const parsed = Number(stableId);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (typeof stableId === "string") {
    const hwnd = /^hwnd:0x([0-9a-f]+)$/iu.exec(stableId.trim());
    if (hwnd) {
      const parsed = Number.parseInt(hwnd[1], 16);
      // Bug 根因：Windows xa11y 将可回传的原生 HWND 编码在 stableId（hwnd:0x...）中，
      // 旧适配只接受纯十进制 stableId，微信这类自绘窗口因此被错误降级为 window_id:null。
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}

function readBounds(value) {
  const bounds = readProperty(value, "bounds");
  if (!isPlainObject(bounds)) return null;
  const fields = [bounds.x, bounds.y, bounds.width, bounds.height];
  return fields.every((field) => typeof field === "number" && Number.isFinite(field))
    ? fields
    : null;
}

function appRecord(app) {
  const root = typeof app?.asElement === "function" ? app.asElement() : undefined;
  const raw = readRaw(root);
  const pid = readProperty(app, "pid");
  const name = readProperty(app, "name");
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    name: typeof name === "string" ? name : null,
    bundle_id: readExplicitString(raw, RAW_BUNDLE_ID_KEYS),
    active: readProperty(app, "isForeground", false) === true,
  };
}

function windowRecord(window, index) {
  const raw = readRaw(window);
  const explicitMain = raw.main ?? raw.is_main ?? raw.ax_main;
  const subrole = readExplicitString(raw, ["subrole", "ax_subrole", "axSubrole"]);
  return {
    index,
    window_id: readWindowId(window),
    title: typeof readProperty(window, "name") === "string" ? readProperty(window, "name") : null,
    bounds: readBounds(window),
    main: typeof explicitMain === "boolean" ? explicitMain : null,
    focused: readProperty(window, "active", false) === true,
    onscreen: readProperty(window, "visible", false) === true,
    ...(subrole === null ? {} : { subrole }),
  };
}

function matchesAppRef(record, ref) {
  return (
    (ref.name === undefined || record.name === ref.name) &&
    (ref.bundle_id === undefined || record.bundle_id === ref.bundle_id) &&
    (ref.pid === undefined || record.pid === ref.pid)
  );
}

function normalizedPlatformIdentity(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";
}

function normalizedDesktopIdentity(value) {
  const normalized = normalizedPlatformIdentity(value);
  return normalized.endsWith(".desktop") ? normalized.slice(0, -".desktop".length) : normalized;
}

function normalizedRunningAppName(value, platform) {
  if (platform === "win32") return normalizeInstalledAppName(value);
  return normalizedPlatformIdentity(value)
    .replace(/\.(?:app|desktop)$/iu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function matchesLaunchedApp(record, ref, installed, platform) {
  if (!installed && matchesAppRef(record, ref)) return true;
  const recordBundleId = normalizedPlatformIdentity(record.bundle_id);
  const installedIds = [
    ...(installed ? [] : [ref.bundle_id]),
    installed?.bundleId,
    installed?.appId,
  ]
    .map(normalizedPlatformIdentity)
    .filter(Boolean);
  if (recordBundleId && installedIds.includes(recordBundleId)) return true;

  // Bug 根因：launcher 接受 Linux desktop id 的可选后缀，producer 过去却严格比较，
  // 导致应用已经启动且可观察时仍耗尽轮询并误报 APP_NOT_READY。
  const desktopIds = [
    ...(installed || platform !== "linux" ? [] : [ref.bundle_id]),
    installed?.desktopId,
  ]
    .map(normalizedDesktopIdentity)
    .filter(Boolean);
  if (recordBundleId && desktopIds.includes(normalizedDesktopIdentity(recordBundleId))) return true;

  const runningName = normalizedRunningAppName(record.name ?? "", platform);
  const installedNames = [...(installed ? [] : [ref.name]), installed?.name, installed?.executable]
    .map((value) => normalizedRunningAppName(value ?? "", platform))
    .filter(Boolean);
  return runningName.length > 0 && installedNames.includes(runningName);
}

function internalWindowIdentity(window, record) {
  const stableId = readProperty(window, "stableId");
  if (typeof stableId === "string" && stableId.length > 0) return `stable:${stableId}`;
  if (record.window_id !== null) return `native:${record.window_id}`;
  return null;
}

function canonicalAppRef(app, window) {
  const ref = {};
  if (app.pid !== null) ref.pid = app.pid;
  else if (app.bundle_id !== null) ref.bundle_id = app.bundle_id;
  else if (app.name !== null) ref.name = app.name;
  if (window?.window_id !== null && window?.window_id !== undefined) {
    ref.window_id = window.window_id;
  }
  return ref;
}

function mapXa11yError(error, fallbackCode, actionSent = false) {
  if (error instanceof Xa11yProducerError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (isXa11yPermissionDenied(error)) {
    return producerError("PERMISSION_DENIED", message, {
      actionSent: false,
      retry: "never",
    });
  }
  if (name === "SelectorNotMatchedError") {
    return producerError("ELEMENT_UNAVAILABLE", message, {
      actionSent: false,
      retry: "reobserve",
    });
  }
  if (name === "ActionNotSupportedError" || name === "InvalidActionDataError") {
    return producerError("ACTION_UNAVAILABLE", message, {
      actionSent: false,
      retry: "reobserve",
    });
  }
  if (isXa11yTimeout(error)) {
    // 已发送的按键/点击不能因超时自动重放；只读观察才允许安全重试。
    return producerError("TIMEOUT", message, {
      actionSent,
      retry: actionSent ? "reobserve" : "retry",
    });
  }
  return producerError(fallbackCode, message || "xa11y operation failed", {
    actionSent,
    retry: actionSent ? "reobserve" : "never",
  });
}

function safeActions(element) {
  const actions = readProperty(element, "actions", []);
  return Array.isArray(actions)
    ? actions.filter((action) => typeof action === "string").toSorted()
    : [];
}

function pureElementRow(element, index, parentIndex, depth) {
  const role = readProperty(element, "role");
  const name = readProperty(element, "name");
  const value = readProperty(element, "value");
  const description = readProperty(element, "description");
  const stableId = readProperty(element, "stableId");
  return {
    index,
    parent_index: parentIndex,
    depth,
    kind: typeof role === "string" ? role : null,
    role: typeof role === "string" ? role : null,
    title: typeof name === "string" ? name : null,
    name: typeof name === "string" ? name : null,
    value: typeof value === "string" ? value : null,
    description: typeof description === "string" ? description : null,
    stable_id: typeof stableId === "string" ? stableId : null,
    bounds: readBounds(element),
    actions: safeActions(element),
    enabled: readProperty(element, "enabled", false) === true,
    visible: readProperty(element, "visible", false) === true,
    focused: readProperty(element, "focused", false) === true,
    active: readProperty(element, "active", false) === true,
    checked: readProperty(element, "checked"),
    selected: readProperty(element, "selected", false) === true,
    expanded: readProperty(element, "expanded"),
    editable: readProperty(element, "editable", false) === true,
    focusable: readProperty(element, "focusable", false) === true,
  };
}

async function captureElementTree(root, maxElements) {
  const entries = [];
  let treeUnavailable = false;
  async function visit(element, parentIndex, depth, path) {
    if (entries.length >= maxElements) {
      throw producerError("STRUCTURED_STATE_UNAVAILABLE", "accessibility tree exceeds limit");
    }
    const index = entries.length;
    const row = pureElementRow(element, index, parentIndex, depth);
    entries.push({ handle: element, row, path });
    let children;
    try {
      children = await element.children();
    } catch (error) {
      const mapped = mapXa11yError(error, "STRUCTURED_STATE_UNAVAILABLE");
      if (mapped.code !== "STRUCTURED_STATE_UNAVAILABLE") throw mapped;
      // Bug 根因：自绘窗口的 UIA 子树可能只在 children() 处返回坏数据；直接抛错会让
      // 截图也无法返回，坐标路径因此被错误地当成 Computer Use 不可用。保留已读节点，
      // 由 getAppState 标记降级并继续取图；元素索引只对实际读到的节点有效。
      treeUnavailable = true;
      return;
    }
    if (!Array.isArray(children)) {
      treeUnavailable = true;
      return;
    }
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      await visit(children[childIndex], index, depth + 1, `${path}.${childIndex}`);
    }
  }
  await visit(root, null, 0, "0");
  return { entries, treeUnavailable };
}

function elementFingerprint(row) {
  return JSON.stringify({
    ...row,
    index: undefined,
    parent_index: undefined,
    depth: undefined,
  });
}

function diffElements(previousEntries, currentEntries) {
  const previous = new Map(previousEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [path, entry] of current) {
    const old = previous.get(path);
    if (!old) added.push(entry.row);
    else if (elementFingerprint(old.row) !== elementFingerprint(entry.row)) updated.push(entry.row);
  }
  for (const [path, entry] of previous) {
    if (!current.has(path)) {
      removed.push({ index: entry.row.index, stable_id: entry.row.stable_id });
    }
  }
  return {
    added_count: added.length,
    removed_count: removed.length,
    updated_count: updated.length,
    added,
    removed,
    updated,
  };
}

function renderElement(row) {
  const indent = "  ".repeat(row.depth);
  const title = row.title === null ? "" : ` ${JSON.stringify(row.title)}`;
  const value = row.value === null ? "" : ` = ${JSON.stringify(row.value)}`;
  const actions = row.actions.length === 0 ? "" : ` (actions: ${row.actions.join(",")})`;
  return `${indent}[${row.index}] ${row.kind ?? "unknown"}${title}${value}${actions}`;
}

function renderStateText(app, window, stateId, entries, changes, treeUnavailable) {
  const header = [
    `state_id: ${stateId}`,
    `app: name=${JSON.stringify(app.name)} pid=${app.pid ?? "null"} bundle_id=${JSON.stringify(app.bundle_id)}`,
    `window: title=${JSON.stringify(window.title)} window_id=${window.window_id ?? "null"}`,
  ];
  const treeWarning = treeUnavailable
    ? `tree_unavailable_reason: ${TREE_UNAVAILABLE_REASON}`
    : undefined;
  if (!changes) {
    return [
      ...header,
      ...(treeWarning ? [treeWarning] : []),
      ...entries.map((entry) => renderElement(entry.row)),
    ].join("\n");
  }
  const changedRows = [...changes.added, ...changes.updated].toSorted((a, b) => a.index - b.index);
  const removed = changes.removed.map((row) => `[-${row.index}] removed`);
  return [
    ...header,
    ...(treeWarning ? [treeWarning] : []),
    ...changedRows.map(renderElement),
    ...removed,
  ].join("\n");
}

function sessionMaps(container, sessionKey) {
  let value = container.get(sessionKey);
  if (!value) {
    value = new Map();
    container.set(sessionKey, value);
  }
  return value;
}
export {
  readProperty,
  appRecord,
  windowRecord,
  matchesAppRef,
  matchesLaunchedApp,
  internalWindowIdentity,
  canonicalAppRef,
  mapXa11yError,
  captureElementTree,
  diffElements,
  renderStateText,
  sessionMaps,
};
