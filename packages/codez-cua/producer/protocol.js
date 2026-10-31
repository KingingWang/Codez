// 原 14 方法的严格协议解析；无 native import、IO 或可变 session 状态。

export const XA11Y_PRODUCER_METHODS = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "set_value",
  "select_text",
  "key",
  "paste",
  "perform_action",
  "request_access",
  "stop_computer_control",
]);

const METHOD_NAMES = new Set(XA11Y_PRODUCER_METHODS);
const APP_REF_KEYS = ["name", "bundle_id", "pid", "window_id"];
const STRATEGIES = new Set(["auto", "a11y", "event"]);
const RETURN_STATES = new Set(["none", "compact", "full"]);
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const TREE_UNAVAILABLE_REASON = "accessibility_tree_unavailable";
const MOUSE_BUTTONS = new Set(["left", "right", "middle"]);
const PASTE_FORMATS = new Set(["text", "md", "html"]);
const RAW_BUNDLE_ID_KEYS = ["bundle_id", "bundleId", "bundle_identifier", "bundleIdentifier"];
const RAW_WINDOW_ID_KEYS = [
  "window_id",
  "windowId",
  "native_window_id",
  "nativeWindowId",
  "hwnd",
  "cg_window_id",
  "cgWindowId",
];

export class Xa11yProducerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "Xa11yProducerError";
    this.code = code;
    this.actionSent = options.actionSent === true;
    this.retry = options.retry ?? "never";
    if (options.details !== undefined) this.details = options.details;
  }
}

function producerError(code, message, options) {
  return new Xa11yProducerError(code, message, options);
}

function normalizeMotionOptions(options) {
  const profile = options.motionProfile ?? "instant";
  if (profile !== "instant" && profile !== "smooth") {
    throw producerError("INVALID_REQUEST", "motion profile must be instant or smooth");
  }
  const durationMs = options.motionDurationMs ?? 160;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 5_000) {
    throw producerError("INVALID_REQUEST", "motion duration must be between 0 and 5000 ms");
  }
  const segmentPixels = options.motionSegmentPixels ?? 80;
  if (!Number.isFinite(segmentPixels) || segmentPixels <= 0) {
    throw producerError("INVALID_REQUEST", "motion segment size must be positive");
  }
  const maxSegments = options.motionMaxSegments ?? 24;
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 2 || maxSegments > 120) {
    throw producerError("INVALID_REQUEST", "motion max segments must be between 2 and 120");
  }
  return { profile, durationMs, segmentPixels, maxSegments };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw producerError("INVALID_REQUEST", `${label} must be an object`);
  return value;
}

function requireExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw producerError("INVALID_REQUEST", `${label} contains unknown fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw producerError("INVALID_REQUEST", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw producerError("INVALID_REQUEST", `${label} must be boolean`);
  return value;
}

function optionalEnum(value, values, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.has(value)) {
    throw producerError("INVALID_REQUEST", `${label} has an unsupported value`);
  }
  return value;
}

function parseAppRef(value, label = "app_ref") {
  const ref = requirePlainObject(value, label);
  requireExactKeys(ref, APP_REF_KEYS, label);
  const parsed = {};
  if (ref.name !== undefined) parsed.name = nonEmptyString(ref.name, `${label}.name`);
  if (ref.bundle_id !== undefined) {
    parsed.bundle_id = nonEmptyString(ref.bundle_id, `${label}.bundle_id`);
  }
  if (ref.pid !== undefined) {
    if (!Number.isSafeInteger(ref.pid) || ref.pid <= 0) {
      throw producerError("INVALID_REQUEST", `${label}.pid must be a positive safe integer`);
    }
    parsed.pid = ref.pid;
  }
  if (ref.window_id !== undefined) {
    if (!Number.isSafeInteger(ref.window_id) || ref.window_id < 0) {
      throw producerError(
        "INVALID_REQUEST",
        `${label}.window_id must be a non-negative safe integer`,
      );
    }
    parsed.window_id = ref.window_id;
  }
  // window_id 只缩小应用内窗口，不能单独充当应用身份；否则跨进程复用的 native id 会歧义。
  if (parsed.name === undefined && parsed.bundle_id === undefined && parsed.pid === undefined) {
    throw producerError("INVALID_APP", `${label} must identify an application`);
  }
  return parsed;
}

function parseTarget(value, label = "target") {
  if (Number.isSafeInteger(value) && value >= 0) return { type: "element", index: value };
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0)
  ) {
    return { type: "coordinate", x: value[0], y: value[1] };
  }
  if (!isPlainObject(value)) {
    throw producerError("INVALID_REQUEST", `${label} must be an element index or coordinate`);
  }
  if (value.type === "element") {
    requireExactKeys(value, ["type", "index"], label);
    if (!Number.isSafeInteger(value.index) || value.index < 0) {
      throw producerError("INVALID_REQUEST", `${label}.index must be a non-negative safe integer`);
    }
    return { type: "element", index: value.index };
  }
  if (value.type === "coordinate") {
    requireExactKeys(value, ["type", "x", "y", "frame_id"], label);
    if (
      !Number.isSafeInteger(value.x) ||
      value.x < 0 ||
      !Number.isSafeInteger(value.y) ||
      value.y < 0
    ) {
      throw producerError("INVALID_REQUEST", `${label} coordinates must be non-negative integers`);
    }
    const target = { type: "coordinate", x: value.x, y: value.y };
    if (value.frame_id !== undefined) {
      target.frameId = nonEmptyString(value.frame_id, `${label}.frame_id`);
    }
    return target;
  }
  throw producerError("INVALID_REQUEST", `${label}.type is unsupported`);
}

function parseModifiers(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") {
    throw producerError("INVALID_REQUEST", "modifiers must be a '+'-separated string");
  }
  return value.split("+").map((part) => normalizeKey(part, true));
}

function normalizeKey(value, modifier = false) {
  const key = nonEmptyString(value, modifier ? "modifier" : "key");
  const lower = key.toLowerCase().replaceAll("_", "");
  const named = {
    alt: "Alt",
    option: "Alt",
    ctrl: "Ctrl",
    control: "Ctrl",
    controll: "Ctrl",
    cmd: "Meta",
    command: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    up: "ArrowUp",
    arrowup: "ArrowUp",
    down: "ArrowDown",
    arrowdown: "ArrowDown",
    left: "ArrowLeft",
    arrowleft: "ArrowLeft",
    right: "ArrowRight",
    arrowright: "ArrowRight",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    space: "Space",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  }[lower];
  if (named) return named;
  if (!modifier && (key.length === 1 || /^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(key))) {
    return key.length === 1 ? key : key.toUpperCase();
  }
  if (modifier) throw producerError("INVALID_REQUEST", `unsupported modifier: ${key}`);
  return key;
}

function parseKeyChord(text) {
  const parts = nonEmptyString(text, "text").split("+");
  if (parts.some((part) => part.trim().length === 0)) {
    throw producerError("INVALID_REQUEST", "text contains an empty key chord part");
  }
  const key = normalizeKey(parts.at(-1));
  const held = parts.slice(0, -1).map((part) => normalizeKey(part, true));
  return { key, held };
}

function optionalAppRef(args) {
  return args.app_ref === undefined ? undefined : parseAppRef(args.app_ref);
}

function parseReturnState(args) {
  return optionalEnum(args.return_state, RETURN_STATES, "none", "return_state");
}

function parseStrategy(args) {
  return optionalEnum(args.strategy, STRATEGIES, "auto", "strategy");
}

function parseParams(method, rawParams) {
  const args = rawParams === undefined ? {} : requirePlainObject(rawParams, "params");
  switch (method) {
    case "list_apps":
      requireExactKeys(args, [], "params");
      return {};
    case "list_windows":
      requireExactKeys(args, ["app_ref"], "params");
      return { appRef: parseAppRef(args.app_ref) };
    case "get_app_state":
      requireExactKeys(
        args,
        ["app_ref", "include_screenshot", "disable_diffing", "tree_shown_to_model"],
        "params",
      );
      return {
        appRef: parseAppRef(args.app_ref),
        includeScreenshot: optionalBoolean(args.include_screenshot, false, "include_screenshot"),
        disableDiffing: optionalBoolean(args.disable_diffing, false, "disable_diffing"),
        treeShownToModel: optionalBoolean(args.tree_shown_to_model, true, "tree_shown_to_model"),
      };
    case "left_click":
      requireExactKeys(
        args,
        [
          "target",
          "mouse_button",
          "click_count",
          "modifiers",
          "strategy",
          "app_ref",
          "return_state",
        ],
        "params",
      );
      if (
        args.click_count !== undefined &&
        (!Number.isSafeInteger(args.click_count) || args.click_count <= 0)
      ) {
        throw producerError("INVALID_REQUEST", "click_count must be a positive safe integer");
      }
      return {
        target: parseTarget(args.target),
        mouseButton: optionalEnum(args.mouse_button, MOUSE_BUTTONS, "left", "mouse_button"),
        clickCount: args.click_count ?? 1,
        modifiers: parseModifiers(args.modifiers),
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "left_click_drag":
      requireExactKeys(
        args,
        ["from_target", "to", "modifiers", "app_ref", "return_state"],
        "params",
      );
      return {
        fromTarget: parseTarget(args.from_target, "from_target"),
        toTarget: parseTarget(args.to, "to"),
        modifiers: parseModifiers(args.modifiers),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "scroll":
      requireExactKeys(
        args,
        ["target", "scroll_direction", "scroll_amount", "strategy", "app_ref", "return_state"],
        "params",
      );
      if (!DIRECTIONS.has(args.scroll_direction)) {
        throw producerError("INVALID_REQUEST", "scroll_direction is unsupported");
      }
      if (
        typeof args.scroll_amount !== "number" ||
        !Number.isFinite(args.scroll_amount) ||
        args.scroll_amount < 0
      ) {
        throw producerError(
          "INVALID_REQUEST",
          "scroll_amount must be a finite non-negative number",
        );
      }
      return {
        target: parseTarget(args.target),
        direction: args.scroll_direction,
        amount: Math.min(args.scroll_amount, 100),
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "type":
      requireExactKeys(args, ["text", "target", "app_ref", "strategy", "return_state"], "params");
      if (typeof args.text !== "string")
        throw producerError("INVALID_REQUEST", "text must be a string");
      return {
        text: args.text,
        target: args.target === undefined ? undefined : parseTarget(args.target),
        appRef: optionalAppRef(args),
        strategy: parseStrategy(args),
        returnState: parseReturnState(args),
      };
    case "set_value":
      requireExactKeys(args, ["target", "value", "strategy", "app_ref", "return_state"], "params");
      if (typeof args.value !== "string")
        throw producerError("INVALID_REQUEST", "value must be a string");
      return {
        target: parseTarget(args.target),
        value: args.value,
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "select_text": {
      requireExactKeys(args, ["target", "text_range", "app_ref", "return_state"], "params");
      let textRange;
      if (args.text_range !== undefined) {
        if (
          !Array.isArray(args.text_range) ||
          args.text_range.length !== 2 ||
          !args.text_range.every((part) => Number.isSafeInteger(part) && part >= 0)
        ) {
          throw producerError("INVALID_REQUEST", "text_range must be [start, length]");
        }
        textRange = [args.text_range[0], args.text_range[1]];
      }
      return {
        target: parseTarget(args.target),
        textRange,
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    }
    case "key":
      requireExactKeys(
        args,
        ["text", "repeat", "hold_seconds", "app_ref", "strategy", "return_state"],
        "params",
      );
      if (
        args.repeat !== undefined &&
        (!Number.isSafeInteger(args.repeat) || args.repeat <= 0 || args.repeat > 100)
      ) {
        throw producerError("INVALID_REQUEST", "repeat must be an integer from 1 to 100");
      }
      if (
        args.hold_seconds !== undefined &&
        (typeof args.hold_seconds !== "number" ||
          !Number.isFinite(args.hold_seconds) ||
          args.hold_seconds < 0 ||
          args.hold_seconds > 60)
      ) {
        throw producerError("INVALID_REQUEST", "hold_seconds must be between 0 and 60");
      }
      return {
        chord: parseKeyChord(args.text),
        repeat: args.repeat ?? 1,
        holdSeconds: args.hold_seconds ?? 0,
        appRef: optionalAppRef(args),
        strategy: parseStrategy(args),
        returnState: parseReturnState(args),
      };
    case "paste":
      requireExactKeys(args, ["text", "format", "app_ref", "return_state"], "params");
      if (typeof args.text !== "string")
        throw producerError("INVALID_REQUEST", "text must be a string");
      return {
        text: args.text,
        format: optionalEnum(args.format, PASTE_FORMATS, "text", "format"),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "perform_action":
      requireExactKeys(args, ["target", "action", "app_ref", "return_state"], "params");
      return {
        target: parseTarget(args.target),
        action: nonEmptyString(args.action, "action"),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "request_access": {
      requireExactKeys(args, ["capabilities"], "params");
      if (
        args.capabilities !== undefined &&
        (!Array.isArray(args.capabilities) ||
          args.capabilities.some((item) => typeof item !== "string" || item.trim().length === 0))
      ) {
        throw producerError("INVALID_REQUEST", "capabilities must be non-empty strings");
      }
      return { capabilities: args.capabilities?.map((item) => item.trim()) };
    }
    case "stop_computer_control":
      requireExactKeys(args, ["reason"], "params");
      if (args.reason !== undefined && typeof args.reason !== "string") {
        throw producerError("INVALID_REQUEST", "reason must be a string");
      }
      return { reason: args.reason };
    default:
      throw producerError("INVALID_REQUEST", "unknown Computer Use method");
  }
}

function parseContext(value) {
  const context = requirePlainObject(value, "context");
  const workspaceKey = nonEmptyString(context.workspaceKey, "context.workspaceKey");
  const sessionId = nonEmptyString(context.sessionId, "context.sessionId");
  return { raw: context, workspaceKey, sessionId, key: `${workspaceKey}\u0000${sessionId}` };
}
export {
  METHOD_NAMES,
  TREE_UNAVAILABLE_REASON,
  RAW_BUNDLE_ID_KEYS,
  RAW_WINDOW_ID_KEYS,
  producerError,
  normalizeMotionOptions,
  isPlainObject,
  requirePlainObject,
  requireExactKeys,
  parseParams,
  parseContext,
};
