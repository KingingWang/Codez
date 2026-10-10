import type { ModelSelection } from "@codez/shared";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { array, object, unsupported, type JsonObject } from "./json.js";
import { extractNativeFileReferences } from "./native-file-reference.js";

/** Native queue edit replaces the whole input array; only verified file parts may survive it. */
export async function replaceQueuedText(
  queue: unknown[],
  id: string,
  text: string,
  sessionId: string,
  resolve?: ResolveAttachments,
): Promise<unknown[]> {
  const queued = queue.map(object).find((item) => item.id === id);
  if (!queued) throw new Error("Queue changed before editing");
  const retained: ({ kind: "part"; value: unknown } | { kind: "marker"; index: number })[] = [];
  const markers: { attachment: AttachmentRef; original: string }[] = [];
  for (const part of array(queued.input)) {
    const value = object(part);
    if (value.type !== "text") {
      retained.push({ kind: "part", value: part });
      continue;
    }
    const partText = typeof value.text === "string" ? value.text : "";
    for (const marker of extractNativeFileReferences(partText)) {
      if (!resolve) unsupported("file references without a staging store");
      // 原因：原生 queue/update 会替换所有 input；仅记下可解析的附件片段，
      // 稍后按原顺序成批重解析，保持 1 MiB 总额决策及小文本全文。
      markers.push({
        attachment: marker.attachment,
        original: partText.slice(marker.start, marker.end),
      });
      retained.push({ kind: "marker", index: markers.length - 1 });
    }
  }
  const restored = markers.length
    ? await resolve!(
        markers.map((entry) => entry.attachment),
        sessionId,
      )
    : [];
  if (
    restored.length !== markers.length ||
    restored.some((part, index) => object(part).text !== markers[index]?.original)
  )
    throw new Error("Queued attachment is unavailable");
  const input = [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...retained.map((part) =>
      part.kind === "marker"
        ? { type: "text", text: markers[part.index]!.original, text_elements: [] }
        : part.value,
    ),
  ];
  if (!input.length) throw new Error("Input cannot be empty");
  return input;
}

export type ResolveAttachments = (refs: AttachmentRef[], sessionId: string) => Promise<unknown[]>;
export async function nativeInput(
  text: string,
  attachments: AttachmentRef[] | undefined,
  sessionId: string,
  resolve?: ResolveAttachments,
): Promise<unknown[]> {
  const input: unknown[] = text ? [{ type: "text", text, text_elements: [] }] : [];
  if (attachments?.length) {
    if (!resolve) unsupported("attachments without a staging store");
    input.push(...(await resolve(attachments, sessionId)));
  }
  if (!input.length) throw new Error("Input cannot be empty");
  return input;
}

export function selectionOverrides(selection: ModelSelection | undefined): Record<string, unknown> {
  return selection ? { model: selection.modelId, effort: selection.options?.reasoningLevel } : {};
}

/**
 * 用户显式选择的权限档位（bridge 进程内事实，specs/codex-permission-modes.md）。
 * 原生没有"ZCode 档位"字段；build 与 custom 在生效值上可能完全相同，
 * 只有记住选择本身才能做投影与 queue 守卫的往返一致。
 */
const REMEMBERED_MODE_KEY = "codezMode";

/** 权限档位值域；plan 是独立勾选维度（collaborationMode），不能被记住成权限档位。 */
const PERMISSION_MODE_IDS = new Set(["build", "edit", "yolo", "custom"]);

export function rememberThreadMode(thread: JsonObject, mode: string | undefined): void {
  if (mode && PERMISSION_MODE_IDS.has(mode)) thread[REMEMBERED_MODE_KEY] = mode;
}

/** 线程当前是否处于放宽态（完全访问沙箱或 AI 代批）；custom 切回时需显式恢复 config.toml。 */
export function isRelaxedThread(thread: JsonObject): boolean {
  return (
    object(thread.sandboxPolicy ?? {}).type === "dangerFullAccess" ||
    thread.approvalsReviewer === "auto_review"
  );
}

/**
 * 投影线程当前权限档位：优先本进程记住的显式选择；无记录时按原生生效值推导。
 * 无显式记录说明线程一直跟随 config.toml（或经 thread/resume 水合），按语义即
 * custom——与旧 build "保留原生权限"行为等价，不猜测用户没做过的选择。
 */
export function projectThreadMode(thread: JsonObject): string {
  const remembered = thread[REMEMBERED_MODE_KEY];
  if (typeof remembered === "string" && remembered) return remembered;
  if (object(thread.sandboxPolicy ?? {}).type === "dangerFullAccess") return "yolo";
  if (thread.approvalsReviewer === "auto_review") return "edit";
  return "custom";
}

export function assertUnchangedInputSettings(
  input: { modelSelection?: ModelSelection; mode?: string; planEnabled?: boolean },
  thread: JsonObject,
): void {
  const selection = input.modelSelection;
  const mode = projectThreadMode(thread);
  const plan = object(thread.collaborationMode ?? {}).mode === "plan";
  if (
    (selection &&
      (selection.modelId !== thread.model ||
        selection.providerId !== thread.modelProvider ||
        (selection.options?.reasoningLevel !== undefined &&
          selection.options.reasoningLevel !== thread.reasoningEffort))) ||
    (input.mode !== undefined && (input.mode === "plan" ? !plan : input.mode !== mode)) ||
    (input.planEnabled !== undefined && input.planEnabled !== plan)
  ) {
    unsupported("per-input settings on queue/steer; change thread settings before submitting");
  }
}

/** config.toml 生效权限值；custom 档从其他显式档位切回时用于恢复原生默认。 */
export interface NativePermissionDefaults {
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: JsonObject;
}

const WORKSPACE_WRITE_SANDBOX: JsonObject = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

/**
 * 档位 → 原生权限参数（specs/codex-permission-modes.md 映射表）。
 * build/edit/yolo 是显式预设，选中即完整下发（含 approvalsReviewer 复位，
 * 不允许只改沙箱留下 AI 代批）；custom 仅在调用方给出 configDefaults
 * （= 正从其他显式档位切回）时恢复 config.toml 值，否则不下发任何覆盖。
 */
export function turnPermissionOverrides(
  mode: string | undefined,
  configDefaults?: NativePermissionDefaults,
): Record<string, unknown> {
  switch (mode) {
    case "yolo":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    case "edit":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { ...WORKSPACE_WRITE_SANDBOX },
      };
    case "build":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { ...WORKSPACE_WRITE_SANDBOX },
      };
    case "custom": {
      if (!configDefaults) return {};
      // config.toml 值不可映射（granular 审批、未知沙箱等）时回退基线：等价"请求批准"。
      const approvalPolicy =
        configDefaults.approvalPolicy === "never" || configDefaults.approvalPolicy === "on-request"
          ? configDefaults.approvalPolicy
          : "on-request";
      const approvalsReviewer =
        configDefaults.approvalsReviewer === "auto_review" ? "auto_review" : "user";
      return {
        approvalPolicy,
        approvalsReviewer,
        sandboxPolicy: configDefaults.sandboxPolicy ?? { ...WORKSPACE_WRITE_SANDBOX },
      };
    }
    default:
      return {};
  }
}

/** 权限覆盖是否随本次请求下发：仅档位发生迁移时显式设置，避免每次提交重置原生会话内授权。 */
export interface TurnPermissionIntent {
  apply: boolean;
  configDefaults?: NativePermissionDefaults;
}

export function turnMode(
  mode: string | undefined,
  model: string | undefined,
  planEnabled?: boolean,
  effort?: string,
  permissions?: TurnPermissionIntent,
): Record<string, unknown> {
  if (!mode && planEnabled === undefined) return {};
  const plan = mode === "plan" || planEnabled === true;
  if (!model) throw new Error("A native model is required to change collaboration mode");
  const collaborationMode = {
    mode: plan ? "plan" : "default",
    settings: {
      model,
      reasoning_effort: effort ?? null,
      developer_instructions: null,
    },
  };
  return {
    collaborationMode,
    ...(permissions?.apply ? turnPermissionOverrides(mode, permissions.configDefaults) : {}),
  };
}

export function decorateNativeThread(response: unknown): Record<string, unknown> {
  const result = object(response);
  const thread = object(result.thread);
  return {
    ...thread,
    ...(result.sandbox ? { sandboxPolicy: result.sandbox } : {}),
    ...(result.approvalPolicy ? { approvalPolicy: result.approvalPolicy } : {}),
    // 原生 resume/start/fork 响应在顶层携带 approvalsReviewer 与 collaborationMode（仅 resume），
    // Thread struct 本身不含权限字段；漏合并会让水合的 auto_review 线程被投影成 custom、plan
    // 态丢失，导致标签与生效权限静默错位（specs/codex-permission-modes.md）。
    ...(result.approvalsReviewer ? { approvalsReviewer: result.approvalsReviewer } : {}),
    ...(result.collaborationMode ? { collaborationMode: result.collaborationMode } : {}),
    ...(typeof result.model === "string" ? { model: result.model } : {}),
    ...(typeof result.reasoningEffort === "string"
      ? { reasoningEffort: result.reasoningEffort }
      : {}),
  };
}
