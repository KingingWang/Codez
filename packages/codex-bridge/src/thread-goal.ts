import {
  commandPayloadSchemas,
  type CommandEnvelope,
  type CommandResult,
  type GoalState,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore, ThreadProjectionState } from "./thread-state.js";
import { nativeInput, selectionOverrides, turnMode, type ResolveAttachments } from "./command-input.js";
import { turnPermissionIntent } from "./control-common.js";
import { object, unsupported, type JsonObject } from "./json.js";
import type { CodexProviderKeyGate } from "./provider-key-gate.js";
import { codexThreadProviderId } from "./commands-edit-retry.js";

/**
 * 原生 Codex `ThreadGoal` 投影到 V4 `GoalState`。
 * 原生 status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"。
 */
export function projectNativeThreadGoal(raw: unknown): GoalState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as JsonObject;
  const objective = typeof record.objective === "string" ? record.objective.trim() : "";
  const rawStatus = typeof record.status === "string" ? record.status : "";
  if (!objective || !rawStatus) return null;
  const status: GoalState["status"] =
    rawStatus === "active"
      ? "active"
      : rawStatus === "complete"
        ? "verified"
        : rawStatus === "blocked" || rawStatus === "usageLimited" || rawStatus === "budgetLimited"
          ? "notSatisfied"
          : "paused";
  const timeUsedSeconds =
    typeof record.timeUsedSeconds === "number" && Number.isFinite(record.timeUsedSeconds)
      ? Math.max(0, Math.floor(record.timeUsedSeconds))
      : 0;
  const updatedAtSec =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Math.floor(Date.now() / 1000);
  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  return {
    targetId: threadId ? `codex-goal:${threadId}` : "codex-goal",
    objective,
    summaryTitle: null,
    timeUsedSeconds,
    activeRunStartedAtMs: status === "active" ? Math.max(0, Math.floor(updatedAtSec * 1000)) : null,
    status,
    iteration: 1,
    verifications: [],
    iterations: [],
  };
}

export function projectGoalActionAvailability(
  projectedGoal: GoalState | null,
  readOnlyBlocked: { allowed: false; reasonCode: string } | undefined,
) {
  const allowed = { allowed: true as const };
  return {
    pauseGoal:
      readOnlyBlocked ??
      (projectedGoal?.status === "active" || projectedGoal?.status === "notSatisfied"
        ? allowed
        : {
            allowed: false as const,
            reasonCode: projectedGoal ? "guard.goalNotActive" : "guard.noGoalToPause",
          }),
    resumeGoal:
      readOnlyBlocked ??
      (projectedGoal?.status === "paused"
        ? allowed
        : {
            allowed: false as const,
            reasonCode: projectedGoal ? "guard.goalNotPaused" : "guard.noGoalToResume",
          }),
  };
}

export async function executeThreadGoalCommand(params: {
  command: CommandEnvelope;
  sessionId: string;
  state: ThreadProjectionState;
  running: JsonObject | undefined;
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  attachments?: ResolveAttachments;
  providerKeyGate?: CodexProviderKeyGate;
}): Promise<CommandResult | undefined> {
  const { command, sessionId, state, running, rpc, store, attachments, providerKeyGate } = params;
  const native = { threadId: sessionId };
  const controlContext = { rpc, cwd: store.cwd };

  if (command.type === "sendGoalCommand") {
    const p = commandPayloadSchemas.sendGoalCommand.parse(command.payload);
    if (p.expectedHeldQueueItemIds) unsupported("held queue item guards");
    const objective = p.text.trim();
    if (!objective) throw new Error("Goal objective cannot be empty");
    if (running) throw new Error("Wait for the active turn before setting a goal");
    await providerKeyGate?.assertTurnAllowed(
      p.modelSelection?.providerId ?? codexThreadProviderId(state.thread),
    );
    if (p.modelSelection || p.mode !== undefined || p.planEnabled !== undefined) {
      const permissions = await turnPermissionIntent(controlContext, state.thread, p.mode);
      const settings = {
        ...native,
        ...selectionOverrides(p.modelSelection),
        ...turnMode(
          p.mode,
          p.modelSelection?.modelId ?? (state.thread.model as string | undefined),
          p.planEnabled,
          p.modelSelection?.options?.reasoningLevel ??
            (state.thread.reasoningEffort as string | undefined),
          permissions,
        ),
      };
      await rpc.request("thread/settings/update", settings);
      store.applySettings(sessionId, {
        ...settings,
        ...(p.modelSelection ? { modelProvider: p.modelSelection.providerId } : {}),
      });
      store.rememberMode(sessionId, p.mode);
    }
    const goalResponse = object(
      await rpc.request("thread/goal/set", {
        ...native,
        origin: "user",
        objective,
        status: "active",
      }),
    );
    if (goalResponse.goal && typeof goalResponse.goal === "object") {
      state.goal = object(goalResponse.goal);
    }
    // 原生 thread/goal/set 不会写入可见 userMessage 行，用 turn/start 发送同一目标，
    // 保证时间线展示用户气泡并由当前会话配置驱动执行。
    const input = await nativeInput(
      p.displayText?.trim() || `/goal ${objective}`,
      undefined,
      sessionId,
      attachments,
    );
    const turnResponse = await rpc.request("turn/start", {
      ...native,
      input,
      clientUserMessageId: command.commandId,
    });
    store.acceptTurnResponse(sessionId, turnResponse);
    return {
      type: "inputAccepted",
      delivery: "startNow",
      inputId: command.commandId,
    };
  }

  if (command.type === "pauseGoal") {
    commandPayloadSchemas.pauseGoal.parse(command.payload);
    if (running) await rpc.request("turn/interrupt", { ...native, turnId: running.id });
    const goalResponse = object(
      await rpc.request("thread/goal/set", {
        ...native,
        origin: "user",
        status: "paused",
      }),
    );
    if (goalResponse.goal && typeof goalResponse.goal === "object") {
      state.goal = object(goalResponse.goal);
    }
    return undefined;
  }

  commandPayloadSchemas.resumeGoal.parse(command.payload);
  if (running) throw new Error("Wait for the active turn before resuming the goal");
  await providerKeyGate?.assertTurnAllowed(codexThreadProviderId(state.thread));
  const goalResponse = object(
    await rpc.request("thread/goal/set", {
      ...native,
      origin: "user",
      status: "active",
    }),
  );
  if (goalResponse.goal && typeof goalResponse.goal === "object") {
    state.goal = object(goalResponse.goal);
  }
  return undefined;
}

