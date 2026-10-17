/**
 * Codex 桌面端钩子（Hooks）管理的数据层（spec: specs/codex-desktop-hooks-and-commands.md）。
 *
 * - 发现与运行态事实源：原生 `hooks/list` RPC。
 * - 总开关与逐条启停/信任：写用户层 `config.toml`（`features.hooks` 与 `hooks.state."<key>"`）。
 * - 新增/编辑/删除 `hooks.json` 条目：走 bridge 控制面 `hooks/configWrite`（在 workspace 所在机器上落盘）。
 */
import {
  codexConfigResponseSchema,
  codexConfigWriteResponseSchema,
  type CodexConfigResponse,
  type CodexHookConfigEvent,
  type CodexHookEventName,
  type CodexHookMetadata,
  type CodexHooksResponse,
  type CodexRequest,
  type CodezHookCommandEntry,
} from "@codez/shared";
import { codexUserConfigTarget } from "./codexSettingsData.js";

export const CODEX_HOOK_CONFIG_EVENTS: readonly CodexHookConfigEvent[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
];

const WIRE_TO_CONFIG_EVENT: Record<CodexHookEventName, CodexHookConfigEvent> = {
  preToolUse: "PreToolUse",
  permissionRequest: "PermissionRequest",
  postToolUse: "PostToolUse",
  preCompact: "PreCompact",
  postCompact: "PostCompact",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmit: "UserPromptSubmit",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  stop: "Stop",
  interrupt: "Interrupt",
};

export function codexWireEventToConfigEvent(eventName: CodexHookEventName): CodexHookConfigEvent {
  return WIRE_TO_CONFIG_EVENT[eventName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `features.hooks` 在 Codex 中默认开启（缺省 !== false）。 */
export function isCodexHooksFeatureEnabled(config: CodexConfigResponse | undefined): boolean {
  const features = config?.config["features"];
  if (!isRecord(features)) return true;
  return features["hooks"] !== false;
}

/** 判断某条钩子是否来自可由 `hooks/configWrite` 读写的 `hooks.json` 命令钩子。 */
export function isEditableHooksJsonEntry(hook: CodexHookMetadata): boolean {
  if (hook.isManaged || hook.handlerType !== "command" || !hook.command) return false;
  if (hook.source !== "user" && hook.source !== "project") return false;
  const normalized = hook.sourcePath.replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("/hooks.json") || normalized === "hooks.json";
}

export interface CodexHooksView {
  projectHooks: CodexHookMetadata[];
  userHooks: CodexHookMetadata[];
  otherHooks: CodexHookMetadata[];
  pendingTrustHooks: CodexHookMetadata[];
  warnings: string[];
  errors: { message: string; sourcePath: string | null }[];
}

export function buildCodexHooksView(response: CodexHooksResponse | undefined): CodexHooksView {
  const entries = response?.data ?? [];
  const allHooks = entries.flatMap((entry) => entry.hooks);
  const warnings = entries.flatMap((entry) => entry.warnings);
  const errors = entries.flatMap((entry) => entry.errors);
  const projectHooks: CodexHookMetadata[] = [];
  const userHooks: CodexHookMetadata[] = [];
  const otherHooks: CodexHookMetadata[] = [];
  const pendingTrustHooks: CodexHookMetadata[] = [];

  for (const hook of allHooks) {
    if (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") {
      pendingTrustHooks.push(hook);
    }
    if (hook.source === "project" && !hook.pluginId) {
      projectHooks.push(hook);
    } else if (hook.source === "user" && !hook.pluginId) {
      userHooks.push(hook);
    } else {
      otherHooks.push(hook);
    }
  }

  const sortByOrder = (a: CodexHookMetadata, b: CodexHookMetadata) =>
    a.displayOrder - b.displayOrder || a.key.localeCompare(b.key);
  projectHooks.sort(sortByOrder);
  userHooks.sort(sortByOrder);
  otherHooks.sort(sortByOrder);

  return {
    projectHooks,
    userHooks,
    otherHooks,
    pendingTrustHooks,
    warnings,
    errors,
  };
}

export interface CodexHookFormState {
  scope: "user" | "project";
  dotCodexFolder?: string;
  originalEntry?: CodezHookCommandEntry;
  event: CodexHookConfigEvent;
  command: string;
  matcher: string;
  timeoutSec: string;
  async: boolean;
  statusMessage: string;
}

export function createEmptyCodexHookForm(
  scope: "user" | "project" = "user",
  dotCodexFolder?: string,
): CodexHookFormState {
  return {
    scope,
    ...(dotCodexFolder ? { dotCodexFolder } : {}),
    event: "PreToolUse",
    command: "",
    matcher: "",
    timeoutSec: "",
    async: false,
    statusMessage: "",
  };
}

export function codexHookMetadataToCommandEntry(hook: CodexHookMetadata): CodezHookCommandEntry {
  return {
    event: codexWireEventToConfigEvent(hook.eventName),
    command: hook.command ?? "",
    ...(hook.matcher ? { matcher: hook.matcher } : {}),
    ...(hook.timeoutSec !== 600 ? { timeoutSec: hook.timeoutSec } : {}),
    ...(hook.async ? { async: true } : {}),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
  };
}

export function codexHookMetadataToForm(hook: CodexHookMetadata): CodexHookFormState {
  const scope: "user" | "project" = hook.source === "project" ? "project" : "user";
  const dotCodexFolder =
    scope === "project"
      ? hook.sourcePath.replace(/[\\/]+hooks\.json$/i, "")
      : undefined;
  const entry = codexHookMetadataToCommandEntry(hook);
  return {
    scope,
    ...(dotCodexFolder && dotCodexFolder !== hook.sourcePath ? { dotCodexFolder } : {}),
    originalEntry: entry,
    event: entry.event,
    command: entry.command,
    matcher: entry.matcher ?? "",
    timeoutSec: hook.timeoutSec && hook.timeoutSec !== 600 ? String(hook.timeoutSec) : "",
    async: Boolean(hook.async),
    statusMessage: entry.statusMessage ?? "",
  };
}

export function codexHookFormToCommandEntry(form: CodexHookFormState): CodezHookCommandEntry {
  const command = form.command.trim();
  if (!command) {
    throw new Error("Hook command is required");
  }
  let timeoutSec: number | undefined;
  const rawTimeout = form.timeoutSec.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
      throw new Error("Timeout must be an integer between 1 and 3600 seconds");
    }
    timeoutSec = parsed;
  }
  const matcher = form.matcher.trim();
  const statusMessage = form.statusMessage.trim();
  return {
    event: form.event,
    command,
    ...(matcher ? { matcher } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    ...(form.async ? { async: true } : {}),
    ...(statusMessage ? { statusMessage } : {}),
  };
}

// ---------------------------------------------------------------------------
// 原生 config.toml 写请求构造（总开关、单条启停、信任哈希）
// ---------------------------------------------------------------------------

type CodexConfigEdit = { keyPath: string; value: unknown; mergeStrategy: "replace" | "upsert" };

export function codexHooksFeatureEdit(enabled: boolean): CodexConfigEdit {
  return {
    keyPath: "features.hooks",
    value: enabled,
    mergeStrategy: "replace",
  };
}

export function codexHookEnabledEdit(key: string, enabled: boolean): CodexConfigEdit {
  return {
    keyPath: "hooks.state",
    value: { [key]: { enabled } },
    mergeStrategy: "upsert",
  };
}

export function codexHookTrustEdits(
  hooks: readonly Pick<CodexHookMetadata, "key" | "currentHash">[],
): CodexConfigEdit[] {
  if (hooks.length === 0) return [];
  const stateMap: Record<string, { trusted_hash: string }> = {};
  for (const hook of hooks) {
    stateMap[hook.key] = { trusted_hash: hook.currentHash };
  }
  return [
    {
      keyPath: "hooks.state",
      value: stateMap,
      mergeStrategy: "upsert",
    },
  ];
}

interface CodexHooksRequestSender {
  request(request: CodexRequest): Promise<unknown>;
}

async function writeUserHooksConfigState(
  sender: CodexHooksRequestSender,
  edits: CodexConfigEdit[],
): Promise<void> {
  if (edits.length === 0) return;
  const fresh = codexConfigResponseSchema.parse(
    await sender.request({ method: "config/read", params: { includeLayers: true } }),
  );
  const target = codexUserConfigTarget(fresh);
  codexConfigWriteResponseSchema.parse(
    await sender.request({
      method: "config/batchWrite",
      params: {
        ...(target ? target : {}),
        edits,
        reloadUserConfig: true,
      },
    }),
  );
}

export async function setCodexHooksFeatureEnabled(
  sender: CodexHooksRequestSender,
  enabled: boolean,
): Promise<void> {
  await writeUserHooksConfigState(sender, [codexHooksFeatureEdit(enabled)]);
}

export async function setCodexHookEnabled(
  sender: CodexHooksRequestSender,
  key: string,
  enabled: boolean,
): Promise<void> {
  await writeUserHooksConfigState(sender, [codexHookEnabledEdit(key, enabled)]);
}

export async function trustCodexHooks(
  sender: CodexHooksRequestSender,
  hooks: readonly Pick<CodexHookMetadata, "key" | "currentHash">[],
): Promise<void> {
  await writeUserHooksConfigState(sender, codexHookTrustEdits(hooks));
}
