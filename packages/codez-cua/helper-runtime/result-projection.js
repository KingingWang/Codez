// 原 Helper 的结果/可信 capture 投影；不保存 session、授权或截图副本。
import { CuaHelperError } from "../broker.js";
import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  readRasterEnvelopeIdentity,
} from "../frame-contract.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "../host-display-contract.js";
import { Xa11yProducerError } from "../xa11y-producer.js";

const PRODUCER_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: "permission_denied",
  INVALID_REQUEST: "invalid_request",
  APP_NOT_FOUND: "app_not_found",
  APP_NOT_READY: "app_not_ready",
  LAUNCH_FAILED: "launch_failed",
  AMBIGUOUS_APP: "ambiguous_app",
  INVALID_APP: "invalid_request",
  ELEMENT_UNAVAILABLE: "element_unavailable",
  STALE_STATE: "element_unavailable",
  NOT_SETTABLE: "not_settable",
  NOT_SELECTABLE: "not_selectable",
  ACTION_UNAVAILABLE: "action_unavailable",
  FOREGROUND_REQUIRED: "foreground_required",
  CONTROL_STOPPED: "controller_busy",
  HELPER_UNAVAILABLE: "broker_unavailable",
  TIMEOUT: "timeout",
  STRUCTURED_STATE_UNAVAILABLE: "element_unavailable",
  INTERNAL: "internal",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function appIdentity(app) {
  if (!isPlainObject(app)) return undefined;
  const pid = Number.isSafeInteger(app.pid) && app.pid > 0 ? app.pid : undefined;
  const bundleId = typeof app.bundle_id === "string" && app.bundle_id ? app.bundle_id : undefined;
  const name = typeof app.name === "string" && app.name ? app.name : undefined;
  const appKey = bundleId ?? (pid === undefined ? undefined : `pid:${pid}`);
  if (!appKey) return undefined;
  return { appKey, ...(name ? { displayName: name } : {}) };
}

function appAssociations(method, value) {
  if (method === "list_apps" && Array.isArray(value)) {
    const items = value.map(appIdentity).map((identity) => identity ?? null);
    return { items };
  }
  const state = isPlainObject(value?.state) ? value.state : value;
  const primary = appIdentity(state?.app);
  return primary ? { primary } : undefined;
}

function frameAppRef(state) {
  if (!isPlainObject(state) || !isPlainObject(state.app)) return undefined;
  const app = state.app;
  const appRef =
    Number.isSafeInteger(app.pid) && app.pid > 0
      ? { pid: app.pid }
      : typeof app.bundle_id === "string" && app.bundle_id.length > 0
        ? { bundle_id: app.bundle_id }
        : typeof app.name === "string" && app.name.length > 0
          ? { name: app.name }
          : undefined;
  if (!appRef) return undefined;
  const windowId = isPlainObject(state.window) ? state.window.window_id : undefined;
  return Number.isSafeInteger(windowId) && windowId >= 0
    ? { ...appRef, window_id: windowId }
    : appRef;
}

function createFrameBlocks(screenshot, state) {
  if (!isPlainObject(screenshot)) return undefined;
  const { data, width, height, frame_id: frameId } = screenshot;
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    typeof frameId !== "string" ||
    frameId.length === 0
  ) {
    return undefined;
  }
  const mimeType = screenshot.mime_type === "image/png" ? screenshot.mime_type : undefined;
  if (!mimeType) return undefined;
  const envelope = readRasterEnvelopeIdentity({ width, height, mimeType });
  if (!envelope) return undefined;
  const appRef = frameAppRef(state);
  const officialRef = {
    type: "codez_cua_frame_ref",
    schemaVersion: 1,
    authority: "codez.cua/open-frame/xa11y-helper",
    frameId,
    contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    mimeType,
    width,
    height,
    envelopeAlgorithm: envelope.algorithm,
    ...(appRef ? { appRef } : {}),
  };
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: JSON.stringify(officialRef) },
      {
        type: "text",
        text: JSON.stringify({
          image_ref: { frame_id: frameId, mime_type: mimeType, width, height },
        }),
      },
    ],
    integrity: {
      contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      envelopeAlgorithm: envelope.algorithm,
    },
  };
}

function withoutScreenshot(value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "screenshot")) return value;
  const { screenshot: _screenshot, mode, ...rest } = value;
  return { ...rest, ...(mode ? { mode, snapshot_mode: mode } : {}) };
}

export function projectProducerResult(method, value) {
  const state = isPlainObject(value?.state) ? value.state : value;
  const frame = createFrameBlocks(state?.screenshot, state);
  const structuredValue = isPlainObject(value?.state)
    ? { ...value, state: withoutScreenshot(value.state) }
    : withoutScreenshot(value);
  const structuredContent =
    isPlainObject(structuredValue) && structuredValue.mode
      ? { ...structuredValue, snapshot_mode: structuredValue.mode }
      : structuredValue;
  const content = frame?.content ?? [
    { type: "text", text: JSON.stringify(value === undefined ? null : value) },
  ];
  const associations = appAssociations(method, value);
  const meta = {
    ...(frame ? { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: frame.integrity } : {}),
    ...(associations ? { [CUA_APP_ASSOCIATIONS_META_KEY]: associations } : {}),
  };
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

function producerError(error) {
  if (!(error instanceof Xa11yProducerError)) return error;
  return new CuaHelperError(error.message, {
    code: PRODUCER_ERROR_CODES[error.code] ?? "internal",
    details: error.details,
    possiblySent: error.actionSent,
    retryable: error.retry === "retry",
  });
}

function trustedCaptureFromResult(method, input, value, context) {
  if (
    method !== "get_app_state" ||
    !isPlainObject(input) ||
    input.include_screenshot !== true ||
    !isPlainObject(context)
  ) {
    return undefined;
  }
  const sessionId =
    typeof context.sessionId === "string" && context.sessionId.trim() === context.sessionId
      ? context.sessionId
      : undefined;
  const turnId =
    typeof context.turnId === "string" && context.turnId.trim() === context.turnId
      ? context.turnId
      : undefined;
  const state = isPlainObject(value?.state) ? value.state : value;
  const screenshot = isPlainObject(state?.screenshot) ? state.screenshot : undefined;
  if (!sessionId || !turnId || !isPlainObject(state) || !screenshot) return undefined;
  const frameId = screenshot.frame_id;
  if (
    typeof frameId !== "string" ||
    frameId.length === 0 ||
    (state.frame_id !== undefined && state.frame_id !== frameId)
  ) {
    return undefined;
  }
  const rawTitle =
    (isPlainObject(state.window) && typeof state.window.title === "string"
      ? state.window.title
      : undefined) ??
    (isPlainObject(state.app) && typeof state.app.name === "string" ? state.app.name : undefined);
  const title =
    typeof rawTitle === "string" &&
    rawTitle.length > 0 &&
    Buffer.byteLength(rawTitle, "utf8") <= 256 &&
    !hasControlCharacter(rawTitle) &&
    rawTitle.trim() === rawTitle
      ? rawTitle
      : undefined;
  return {
    sessionId,
    turnId,
    frameId,
    mimeType: screenshot.mime_type,
    data: screenshot.data,
    width: screenshot.width,
    height: screenshot.height,
    ...(title ? { title } : {}),
  };
}
export { isPlainObject, producerError, trustedCaptureFromResult };
