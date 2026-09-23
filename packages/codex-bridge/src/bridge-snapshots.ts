import { randomUUID } from "node:crypto";
import { formatModelPickerValue } from "@codez/shared";
import {
  workspaceConfigSnapshotSchema,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext } from "./contract.js";
import { DeletedThreadError, type ThreadStateStore } from "./thread-state.js";
import type { InteractionBroker } from "./interactions.js";
import { readControlModelSettings, readControlPresentation } from "./control-presentation.js";
import { projectThread, projectSessionsIndex } from "./projection.js";
import { array, object, string } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { itemEntityId } from "./projection-rows.js";
import type { AttachmentStore, AttachmentReadAuthorization } from "./attachments.js";

export class BridgeSnapshots {
  private readonly indexEpoch = randomUUID();
  private readonly configEpoch = randomUUID();
  private indexSeq = 0;
  private configSeq = 0;
  private readonly attachmentViews = new Map<
    string,
    { epoch: string; rows: ConversationSnapshot["rows"]["window"] }
  >();
  constructor(
    private readonly context: BridgeControlContext,
    private readonly store: ThreadStateStore,
    private readonly interactions: InteractionBroker,
    readonly workspaceId: string,
    private readonly attachments?: AttachmentStore,
  ) {}

  async conversation(id: string): Promise<ConversationSnapshot> {
    const state = await this.store.ensure(id);
    const snapshot = projectThread(state.thread, {
      workspacePath: this.store.cwd,
      workspaceId: this.workspaceId,
      logEpoch: state.epoch,
      seq: state.seq,
      revision: state.revision,
      queue: state.queue,
      interactions: this.interactions.list(id),
    });
    if (state.thread.tokenUsage) {
      const usage = object(state.thread.tokenUsage);
      const total = object(usage.total);
      const last = object(usage.last);
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      snapshot.usage = {
        cumulative: {
          inputTokens: count(total.inputTokens),
          outputTokens: count(total.outputTokens),
          cacheReadTokens: count(total.cachedInputTokens),
          cacheWriteTokens: count(total.cacheWriteInputTokens),
        },
        contextWindow:
          typeof usage.modelContextWindow === "number"
            ? {
                usedTokens: count(last.totalTokens),
                maxTokens: usage.modelContextWindow,
                autoCompactThresholdTokens: null,
              }
            : null,
      };
    }
    const idle = snapshot.control.phase !== "running";
    snapshot.config.mode =
      state.thread.sandboxPolicy && object(state.thread.sandboxPolicy).type === "dangerFullAccess"
        ? "yolo"
        : "build";
    if (state.thread.collaborationMode)
      snapshot.config.planEnabled = object(state.thread.collaborationMode).mode === "plan";
    const allowed = { allowed: true as const };
    snapshot.availability = {
      ...snapshot.availability,
      fork: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      compact: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      switchModelConfig: allowed,
      queueEdit: allowed,
      sendQueuedNow: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
    };
    for (const row of snapshot.rows.window) {
      if (idle && row.kind === "assistantText") row.actions = { canFork: true };
      if (idle && row.kind === "userInput")
        row.actions = { canEdit: true, canRetry: true, editDisposition: "rewind" };
      if (row.kind === "turnHeader") {
        const turn = array(state.thread.turns)
          .map(object)
          .find((item) => item.id === row.turnId);
        if (turn) {
          const { files, additions, deletions } = projectTurnFileChanges(turn);
          if (files) row.fileChanges = { files, additions, deletions };
        }
      }
      if (row.kind === "userInput" && this.attachments) {
        // entityId 是 turn 作用域的稳定展示键；与投影同一纯函数比较即可找回原始
        // userMessage，不做解码，也不依赖 rowId/header 的位置布局。
        const turn = array(state.thread.turns)
          .map(object)
          .find((candidate) => candidate.id === row.turnId);
        const entityId = row.entityId;
        const nativeTurnId = typeof turn?.id === "string" ? turn.id : undefined;
        const user =
          typeof entityId === "string" && nativeTurnId !== undefined
            ? array(turn?.items)
                .map(object)
                .find(
                  (item) =>
                    item.type === "userMessage" &&
                    itemEntityId(nativeTurnId, string(item.id)) === entityId,
                )
            : undefined;
        const refs = await Promise.all(
          array(user?.content).map(async (part) => {
            const input = object(part);
            return input.type === "localImage" && typeof input.path === "string"
              ? this.attachments!.findNativeAttachment(input.path, id)
              : input.type === "image" && typeof input.url === "string"
                ? this.attachments!.findNativeImageAttachment(input.url, id)
                : undefined;
          }),
        );
        row.attachments = refs.filter((ref) => ref !== undefined);
      }
    }
    if (this.store.get(id) !== state) throw new DeletedThreadError();
    this.attachmentViews.set(id, { epoch: snapshot.logEpoch, rows: snapshot.rows.window });
    return snapshot;
  }

  authorizeAttachment(query: AttachmentReadAuthorization): boolean {
    const view = this.attachmentViews.get(query.sessionId);
    const state = this.store.get(query.sessionId);
    if (!view || !state || view.epoch !== state.epoch) return false;
    return view.rows.some(
      (row) =>
        row.kind === "userInput" &&
        (!query.target ||
          (row.rowId === query.target.rowId && row.entityId === query.target.entityId)) &&
        row.attachments?.some(
          (ref, index) =>
            ref.ref === query.ref &&
            (query.attachmentIndex === undefined || index === query.attachmentIndex),
        ),
    );
  }

  async topic(topic: string): Promise<{ snapshot: unknown; seq: number; logEpoch: string }> {
    if (topic.startsWith("conversation/")) {
      const snapshot = await this.conversation(topic.slice("conversation/".length));
      // 历史分页和实时尾窗分离，避免一个大型历史会话超出物理传输预算。
      snapshot.rows.window = snapshot.rows.window.slice(-60);
      snapshot.rows.firstRowId = snapshot.rows.window[0]?.rowId ?? null;
      return { snapshot, seq: snapshot.seq, logEpoch: snapshot.logEpoch };
    }
    if (topic === `sessions-index/${this.workspaceId}`) {
      const threads = await this.store.list();
      return {
        snapshot: projectSessionsIndex(threads, {
          workspacePath: this.store.cwd,
          workspaceId: this.workspaceId,
          logEpoch: this.indexEpoch,
        }),
        seq: ++this.indexSeq,
        logEpoch: this.indexEpoch,
      };
    }
    if (topic === `workspace-config/${this.workspaceId}`) {
      const [settings, presentation] = await Promise.all([
        readControlModelSettings(this.context),
        readControlPresentation(
          { workspacePath: this.store.cwd, workspaceKey: this.workspaceId },
          this.context,
        ),
      ]);
      const snapshot = workspaceConfigSnapshotSchema.parse({
        protocolVersion: 1,
        workspaceId: this.workspaceId,
        logEpoch: this.configEpoch,
        config: {
          slashCommands: presentation.slashCommands,
          configOptions: [
            {
              id: "model",
              name: "Codex model",
              type: "select",
              currentValue: formatModelPickerValue(settings.model.current),
              options: settings.model.available.map((model) => ({
                value: formatModelPickerValue(model.ref),
                name: model.label,
                description: model.description,
                origin: "native",
                modelProviderId: model.ref.providerId,
                modelProviderName: model.providerLabel,
                modelThoughtLevels: model.reasoning?.levels.map((level) => level.value),
                modelDefaultThoughtLevel: model.reasoning?.defaultLevel,
              })),
            },
            {
              id: "thought_level",
              name: "Reasoning",
              type: "select",
              currentValue: settings.thoughtLevel.current ?? "",
              options: settings.thoughtLevel.available.map((level) => ({
                value: level.value,
                name: level.label,
              })),
            },
            {
              id: "mode",
              name: "Codex mode",
              type: "select",
              currentValue: settings.mode.current,
              options: [
                { value: "build", name: "Default" },
                { value: "plan", name: "Plan" },
                { value: "yolo", name: "Full access" },
              ],
            },
          ],
        },
      });
      return { snapshot, seq: ++this.configSeq, logEpoch: this.configEpoch };
    }
    throw new Error("Subscription topic is outside this workspace");
  }
}
