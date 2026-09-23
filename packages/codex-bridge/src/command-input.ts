import type { ModelSelection } from "@codez/shared";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { array, object, unsupported, type JsonObject } from "./json.js";

/** The native edit replaces the entire input array; retain media when editing only text. */
export function replaceQueuedText(queue: unknown[], id: string, text: string): unknown[] {
  const queued = queue.map(object).find((item) => item.id === id);
  if (!queued) throw new Error("Queue changed before editing");
  const nonText = array(queued.input).filter((part) => object(part).type !== "text");
  const input = [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...nonText];
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

export function assertUnchangedInputSettings(
  input: { modelSelection?: ModelSelection; mode?: string; planEnabled?: boolean },
  thread: JsonObject,
): void {
  const selection = input.modelSelection;
  const mode = object(thread.sandboxPolicy ?? {}).type === "dangerFullAccess" ? "yolo" : "build";
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

export function turnMode(
  mode: string | undefined,
  model: string | undefined,
  planEnabled?: boolean,
  effort?: string,
  currentSandbox?: unknown,
  explicitPermissionChange = false,
): Record<string, unknown> {
  if (!mode && planEnabled === undefined) return {};
  if (mode === "edit") unsupported("edit mode (Codex has default/plan collaboration modes)");
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
  const leavingFullAccess =
    currentSandbox &&
    typeof currentSandbox === "object" &&
    "type" in currentSandbox &&
    currentSandbox.type === "dangerFullAccess";
  // 普通发送保留原生权限；但退出 Full access 时必须真正恢复沙箱，不能只更新界面标签。
  return {
    collaborationMode,
    ...(mode === "yolo"
      ? {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }
      : mode === "build" && (explicitPermissionChange || leavingFullAccess)
        ? {
            approvalPolicy: "on-request",
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          }
        : {}),
  };
}

export function decorateNativeThread(response: unknown): Record<string, unknown> {
  const result = object(response);
  const thread = object(result.thread);
  return {
    ...thread,
    ...(result.sandbox ? { sandboxPolicy: result.sandbox } : {}),
    ...(result.approvalPolicy ? { approvalPolicy: result.approvalPolicy } : {}),
    ...(typeof result.model === "string" ? { model: result.model } : {}),
    ...(typeof result.reasoningEffort === "string"
      ? { reasoningEffort: result.reasoningEffort }
      : {}),
  };
}
