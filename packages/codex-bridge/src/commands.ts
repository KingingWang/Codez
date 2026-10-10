import {
  commandAckSchema,
  commandPayloadSchemas,
  parseCommandEnvelope,
  type CommandAck,
  type CommandEnvelope,
  type CommandResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import type { InteractionBroker } from "./interactions.js";
import type { CommandLedger } from "./command-ledger.js";
import {
  decorateNativeThread,
  assertUnchangedInputSettings,
  nativeInput,
  selectionOverrides,
  turnMode,
  type ResolveAttachments,
} from "./command-input.js";
import {
  assertWritableThreadState,
  preemptByInterrupt,
  turnPermissionIntent,
  WriterConflictError,
} from "./control-common.js";
import { array, object, string, unsupported } from "./json.js";
import { projectThread } from "./projection.js";
import { createNativeSession } from "./command-create.js";
import { formatRewindNotice, type RewindNoticeStore } from "./rewind-notice.js";
import { createSelectionSideSession } from "./selection-side-session-command.js";
import { editQueuedInput } from "./queue-edit.js";
import { applySelectionSideChatBoundary } from "./selection-side-chat.js";
import type { SessionTitleCoordinator } from "./session-title.js";

export interface CommandContext {
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  interactions: InteractionBroker;
  ledger: CommandLedger;
  workspaceId: string;
  attachments?: ResolveAttachments;
  /**
   * Desktop 文件撤销的一次性模型通知（spec: codex-desktop-file-rewind）。
   * 缺省时 sendText 不注入，保持旧嵌入方/测试语义。
   */
  rewindNotices?: RewindNoticeStore;
  title?: SessionTitleCoordinator;
}

/** Per-thread serialization covers admission decisions, not native execution. */
export class CommandRouter {
  private readonly serial = new Map<string, Promise<unknown>>();
  constructor(private readonly context: CommandContext) {}

  async execute(value: unknown): Promise<CommandAck> {
    const parsed = parseCommandEnvelope(value);
    if (!parsed.ok)
      throw Object.assign(new Error("Invalid conversation command"), { code: -32602 });
    const command = parsed.envelope;
    const key = command.sessionId ?? "create";
    const previous = this.serial.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.admit(command));
    this.serial.set(key, next);
    try {
      return await next;
    } finally {
      if (this.serial.get(key) === next) this.serial.delete(key);
    }
  }

  private async admit(command: CommandEnvelope): Promise<CommandAck> {
    const { store, ledger } = this.context;
    const existing = await ledger.lookup(command.sessionId, command.commandId);
    if (existing && existing !== "unknown") return existing;
    if (existing === "unknown" || !(await ledger.begin(command.sessionId, command.commandId))) {
      return {
        commandId: command.commandId,
        status: "failed",
        reasonCode: "codex.commandOutcomeUnknown",
        message:
          "The previous native request may have completed. Refresh history; do not resend automatically.",
        revisionAtDecision: 0,
      };
    }
    let ack: CommandAck;
    try {
      const state = command.sessionId ? await store.ensure(command.sessionId) : undefined;
      if (
        state &&
        ((command.baseRevision !== undefined && command.baseRevision !== state.revision) ||
          (command.baseLogEpoch !== undefined && command.baseLogEpoch !== state.epoch))
      ) {
        ack = {
          commandId: command.commandId,
          status: "stale",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: state.revision,
        };
      } else {
        const result = await this.dispatch(command);
        ack = {
          commandId: command.commandId,
          status: "accepted",
          revisionAtDecision: state?.revision ?? 0,
          ...(result ? { result } : {}),
        };
      }
    } catch (error) {
      ack =
        error instanceof WriterConflictError
          ? {
              commandId: command.commandId,
              status: "rejected",
              reasonCode: "guard.codex.writerConflict",
              message: error.message,
              revisionAtDecision: 0,
            }
          : {
              commandId: command.commandId,
              status: "failed",
              revisionAtDecision: 0,
              reasonCode: "codex.commandFailed",
              message: error instanceof Error ? error.message : "Native request failed",
            };
    }
    await ledger.finish(command.sessionId, ack);
    return commandAckSchema.parse(ack);
  }

  private async dispatch(command: CommandEnvelope): Promise<CommandResult | undefined> {
    const { rpc, store, attachments, interactions } = this.context;
    if (command.type === "createSession") return createNativeSession(command, this.context);
    const sessionId = string(command.sessionId, "sessionId");
    const state = await store.ensure(sessionId);
    assertWritableThreadState(state, command.type);
    const native = { threadId: sessionId };
    // config.toml 生效值读取上下文；权限覆盖仅在档位迁移时下发（specs/codex-permission-modes.md）。
    const controlContext = { rpc, cwd: store.cwd };
    const running = array(state.thread.turns)
      .map(object)
      .findLast((turn) => turn.status === "inProgress");
    switch (command.type) {
      case "sendText": {
        const p = commandPayloadSchemas.sendText.parse(command.payload);
        // 原生按 catalog 的 per-model provider 路由；线程 provider 跟随本次选择。
        // 创建期 ThreadSettings.model_provider 不代表执行归属（specs/codex-model-provider-grouping.md）。
        if (p.context_refs?.length) unsupported("shared-context execution");
        // heldQueueDisposition 只在 legacy held(choice) 路由下有事务语义（clear/keep
        // 队列后 startNow）；Codex 没有 held queue，投影永不报 choice，该字段无事务
        // 可执行。replayable 路径（Bot/Automation/手机）为对齐旧 session/send 语义
        // 无条件携带 keepQueueAndSend，与 bridge 默认 delivery（running→queue /
        // idle→startNow，即"不动既有队列"）天然一致——接受并忽略，不能拒绝，
        // 否则所有 Bot 回调消息都会在 admission 前失败。
        // expectedHeldQueueItemIds 是 choice 确认框的过期守卫，bridge 无 held queue
        // 状态可校验，合法发送端（投影从未报 choice）不会携带，继续 fail-closed 拒绝。
        if (p.expectedHeldQueueItemIds) unsupported("held queue item guards");
        if (
          p.browserAmbientContext ||
          p.modelExecution ||
          p.automationId ||
          p.offPeakTaskId ||
          p.toolDisallowlist?.length
        )
          unsupported("legacy execution context; this intent cannot be safely applied by Codex");
        // 撤销通知随下一条用户文本进入 Codex 事实；peek 不消费，
        // native 请求失败时通知保留，下一次发送重试。
        const rewindNotice = this.context.rewindNotices?.peek(sessionId);
        const rawText = rewindNotice ? `${formatRewindNotice(rewindNotice)}\n\n${p.text}` : p.text;
        const text = applySelectionSideChatBoundary(state.sideChat, state.thread, rawText);
        const input = await nativeInput(text, p.attachments, sessionId, attachments);
        // busy 默认入队：排队消息立即可见、可编辑/删除；steer 只保留给显式 guide（specs/codex-desktop-adapter.md）。
        const delivery = p.requestedDelivery ?? (running ? "queue" : "startNow");
        if (p.titleGenerationModel) this.context.title?.arm(sessionId, p.titleGenerationModel);
        if (delivery === "queue" || (delivery === "guide" && running))
          assertUnchangedInputSettings(p, state.thread);
        if (delivery === "queue") {
          await rpc.request("thread/queue/add", {
            ...native,
            input,
            clientUserMessageId: command.commandId,
          });
          await store.refreshQueue(sessionId);
        } else if (delivery === "guide" && running) {
          await rpc.request("turn/steer", {
            ...native,
            input,
            expectedTurnId: running.id,
            clientUserMessageId: command.commandId,
          });
        } else {
          // busy 时 startNow = 抢占：interrupt 后的 Interrupted idle 不触发队列
          // 自动 dispatch（specs/codex-desktop-adapter.md）。
          if (running) await preemptByInterrupt(rpc, native, string(running.id, "turnId"));
          const permissions = await turnPermissionIntent(controlContext, state.thread, p.mode);
          const turnParams = {
            ...native,
            input,
            clientUserMessageId: command.commandId,
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
          const response = await rpc.request("turn/start", turnParams);
          store.applySettings(sessionId, {
            ...turnParams,
            ...(p.modelSelection ? { modelProvider: p.modelSelection.providerId } : {}),
          });
          store.acceptTurnResponse(sessionId, response);
          store.rememberMode(sessionId, p.mode);
        }
        // 三个投递分支（queue/steer/start）都在此汇合且 native 已成功，消费通知。
        // 恰好同批：并发 record 的新条目留给再下一条消息。
        if (rewindNotice) this.context.rewindNotices?.clear(sessionId, rewindNotice);
        return {
          type: "inputAccepted",
          delivery: delivery === "guide" && !running ? "startNow" : delivery,
          inputId: command.commandId,
        };
      }
      case "stop": {
        const p = commandPayloadSchemas.stop.parse(command.payload);
        if (p.expectedForegroundExecutionId && p.expectedForegroundExecutionId !== running?.id)
          throw new Error("Turn changed before stop");
        if (running) await rpc.request("turn/interrupt", { ...native, turnId: running.id });
        break;
      }
      case "compact":
        if (running) throw new Error("Wait for the active turn before compacting");
        await rpc.request("thread/compact/start", native);
        break;
      case "renameSession": {
        const title = commandPayloadSchemas.renameSession.parse(command.payload).title;
        await (this.context.title?.manualRename(sessionId, title) ??
          rpc.request("thread/name/set", { ...native, name: title }));
        break;
      }
      case "deleteSession":
        if (running) throw new Error("Stop the active turn before deleting");
        this.context.title?.cancel(sessionId);
        await rpc.request("thread/delete", native);
        store.remove(sessionId);
        break;
      case "resolveInteraction": {
        const p = commandPayloadSchemas.resolveInteraction.parse(command.payload);
        await interactions.resolve(sessionId, p.interactionId, p.answer);
        break;
      }
      case "switchModelConfig": {
        const p = commandPayloadSchemas.switchModelConfig.parse(command.payload);
        // 跨 provider 换模型由 codex 原生按 catalog 路由（thread/settings/update
        // 实测接受任意目录模型），bridge 记录跟随选择的 provider 归属。
        await rpc.request("thread/settings/update", {
          ...native,
          model: p.model,
          effort: p.thought || undefined,
        });
        state.thread.model = p.model;
        state.thread.modelProvider = p.provider;
        if (p.thought) state.thread.reasoningEffort = p.thought;
        break;
      }
      case "switchCollaborationMode": {
        const p = commandPayloadSchemas.switchCollaborationMode.parse(command.payload);
        // 与 sendText 同一迁移规则（specs/codex-permission-modes.md）。
        const permissions = await turnPermissionIntent(controlContext, state.thread, p.mode);
        const settings = {
          ...native,
          ...turnMode(
            p.mode,
            string(state.thread.model, "model"),
            undefined,
            state.thread.reasoningEffort as string | undefined,
            permissions,
          ),
        };
        await rpc.request("thread/settings/update", settings);
        store.applySettings(sessionId, settings);
        store.rememberMode(sessionId, p.mode);
        break;
      }
      case "sendQueuedNow": {
        const p = commandPayloadSchemas.sendQueuedNow.parse(command.payload);
        // busy 抢占：interrupt 后队列不因 Interrupted idle 自动 dispatch，其余队列项保留。
        if (running) await preemptByInterrupt(rpc, native, string(running.id, "turnId"));
        const response = await rpc.request("thread/queue/start", {
          ...native,
          queuedSubmissionId: p.queueItemId,
        });
        store.acceptTurnResponse(sessionId, response);
        await store.refreshQueue(sessionId);
        break;
      }
      case "editQueueItem": {
        const p = commandPayloadSchemas.editQueueItem.parse(command.payload);
        await editQueuedInput(rpc, store, sessionId, p, attachments);
        break;
      }
      case "deleteQueueItem": {
        const p = commandPayloadSchemas.deleteQueueItem.parse(command.payload);
        await rpc.request("thread/queue/delete", { ...native, queuedSubmissionId: p.queueItemId });
        await store.refreshQueue(sessionId);
        break;
      }
      case "reorderQueueItem": {
        const p = commandPayloadSchemas.reorderQueueItem.parse(command.payload);
        await store.refreshQueue(sessionId);
        const ids = state.queue.map((entry) => string(object(entry).id));
        if (
          !ids.includes(p.queueItemId) ||
          (p.beforeQueueItemId && !ids.includes(p.beforeQueueItemId))
        )
          throw new Error("Queue changed");
        const reordered = ids.filter((id) => id !== p.queueItemId);
        reordered.splice(
          p.beforeQueueItemId ? reordered.indexOf(p.beforeQueueItemId) : reordered.length,
          0,
          p.queueItemId,
        );
        await rpc.request("thread/queue/reorder", { ...native, queuedSubmissionIds: reordered });
        await store.refreshQueue(sessionId);
        break;
      }
      case "forkAssistant": {
        const p = commandPayloadSchemas.forkAssistant.parse(command.payload);
        const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
        const row = snapshot.rows.window.find(
          (candidate) =>
            candidate.rowId === p.target.rowId && candidate.entityId === p.target.entityId,
        );
        if (!row) throw new Error("Target row no longer exists");
        const result = decorateNativeThread(
          await rpc.request("thread/fork", { ...native, lastTurnId: row.turnId }),
        );
        store.markStarted(result);
        await store.reloadAfterHistoryChange(string(result.id));
        return { type: "forkAssistant", sessionId: string(result.id) };
      }
      case "createSelectionSideSession":
        return createSelectionSideSession(command, this.context);
      case "editUserQuery":
      case "retryTurn": {
        this.context.title?.cancel(sessionId);
        const p =
          command.type === "editUserQuery"
            ? commandPayloadSchemas.editUserQuery.parse(command.payload)
            : commandPayloadSchemas.retryTurn.parse(command.payload);
        if (running) throw new Error("Stop the active turn before changing conversation history");
        if ("workspaceMode" in p && p.workspaceMode === "rewind")
          unsupported("file rewind; Codex history revert does not undo files");
        const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
        const row = snapshot.rows.window.find(
          (candidate) =>
            candidate.rowId === p.target.rowId && candidate.entityId === p.target.entityId,
        );
        if (!row) throw new Error("Target row no longer exists");
        const turn = array(state.thread.turns)
          .map(object)
          .find((candidate) => candidate.id === row.turnId);
        const user = array(turn?.items)
          .map(object)
          .find((item) => item.type === "userMessage");
        if (!user) throw new Error("Original user input is unavailable");
        const edit =
          command.type === "editUserQuery"
            ? commandPayloadSchemas.editUserQuery.parse(command.payload)
            : undefined;
        const input = edit
          ? await nativeInput(edit.newText, edit.attachments, sessionId, attachments)
          : user.content;
        await rpc.request("thread/revert", { ...native, beforeTurnId: row.turnId });
        await store.reloadAfterHistoryChange(sessionId);
        const response = await rpc.request("turn/start", {
          ...native,
          input,
          clientUserMessageId: command.commandId,
        });
        store.acceptTurnResponse(sessionId, response);
        break;
      }
      default:
        unsupported(command.type);
    }
    store.touch(sessionId);
    return undefined;
  }
}
