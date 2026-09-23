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
  replaceQueuedText,
  nativeInput,
  selectionOverrides,
  turnMode,
  type ResolveAttachments,
} from "./command-input.js";
import { array, object, string, unsupported } from "./json.js";
import { projectThread } from "./projection.js";
import { createNativeSession } from "./command-create.js";

/** writer-conflict 只读会话上的既有会话命令拒绝；admit 映射为 guard.codex.writerConflict。 */
export class WriterConflictError extends Error {
  constructor() {
    super("Thread is read-only: another writer holds the session lock");
  }
}

export interface CommandContext {
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  interactions: InteractionBroker;
  ledger: CommandLedger;
  workspaceId: string;
  attachments?: ResolveAttachments;
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
    // writer-conflict 只读：另一进程持有该线程写锁。deny-by-default——除 forkAssistant
    // （thread/fork 读源线程 rollout、不取源写锁，是只读会话唯一的逃生通道）外，
    // 既有会话命令一律在此拒绝；不做逐命令枚举，未来的写命令也自动被覆盖。
    if (state.readOnly === "writer-conflict" && command.type !== "forkAssistant")
      throw new WriterConflictError();
    const native = { threadId: sessionId };
    const running = array(state.thread.turns)
      .map(object)
      .findLast((turn) => turn.status === "inProgress");
    switch (command.type) {
      case "sendText": {
        const p = commandPayloadSchemas.sendText.parse(command.payload);
        if (p.modelSelection && p.modelSelection.providerId !== state.thread.modelProvider) {
          unsupported("changing provider on an existing thread; create a new thread");
        }
        if (p.context_refs?.length) unsupported("shared-context execution");
        if (p.heldQueueDisposition || p.expectedHeldQueueItemIds)
          unsupported("held queue dispositions");
        if (
          p.browserAmbientContext ||
          p.modelExecution ||
          p.automationId ||
          p.offPeakTaskId ||
          p.toolDisallowlist?.length
        )
          unsupported("legacy execution context; this intent cannot be safely applied by Codex");
        const input = await nativeInput(p.text, p.attachments, sessionId, attachments);
        const delivery = p.requestedDelivery ?? (running ? "guide" : "startNow");
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
          if (running)
            throw new Error("A turn is already running; stop, guide, or queue the input");
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
              state.thread.sandboxPolicy,
            ),
          };
          const response = await rpc.request("turn/start", turnParams);
          store.applySettings(sessionId, turnParams);
          store.acceptTurnResponse(sessionId, response);
        }
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
      case "renameSession":
        await rpc.request("thread/name/set", {
          ...native,
          name: commandPayloadSchemas.renameSession.parse(command.payload).title,
        });
        break;
      case "deleteSession":
        if (running) throw new Error("Stop the active turn before deleting");
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
        if (p.provider !== state.thread.modelProvider)
          unsupported("changing provider on an existing thread; create a new thread");
        await rpc.request("thread/settings/update", {
          ...native,
          model: p.model,
          effort: p.thought || undefined,
        });
        state.thread.model = p.model;
        if (p.thought) state.thread.reasoningEffort = p.thought;
        break;
      }
      case "switchCollaborationMode": {
        const p = commandPayloadSchemas.switchCollaborationMode.parse(command.payload);
        const settings = {
          ...native,
          ...turnMode(
            p.mode,
            string(state.thread.model, "model"),
            undefined,
            state.thread.reasoningEffort as string | undefined,
            state.thread.sandboxPolicy,
            true,
          ),
        };
        await rpc.request("thread/settings/update", settings);
        store.applySettings(sessionId, settings);
        break;
      }
      case "sendQueuedNow": {
        const p = commandPayloadSchemas.sendQueuedNow.parse(command.payload);
        if (running) throw new Error("Stop the current turn before starting a queued input");
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
        await store.refreshQueue(sessionId);
        await rpc.request("thread/queue/update", {
          ...native,
          queuedSubmissionId: p.queueItemId,
          input: replaceQueuedText(state.queue, p.queueItemId, p.newText),
        });
        await store.refreshQueue(sessionId);
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
      case "editUserQuery":
      case "retryTurn": {
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
