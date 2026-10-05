import { randomUUID } from "node:crypto";
import { formatModelPickerValue, getCodexPermissionModes } from "@codez/shared";
import {
  workspaceConfigSnapshotSchema,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext } from "./contract.js";
import { DeletedThreadError, type ThreadStateStore } from "./thread-state.js";
import type { InteractionBroker } from "./interactions.js";
import { readControlModelSettings, readControlPresentation } from "./control-presentation.js";
import { projectThreadMode } from "./command-input.js";
import { projectThread, projectSessionsIndex } from "./projection.js";
import { array, object, string } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { itemEntityId } from "./projection-rows.js";
import { projectConversationTailWindow } from "./projection-window.js";
import type { AttachmentStore, AttachmentReadAuthorization } from "./attachments.js";

function safeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sparseNativeUsage(value: unknown): ConversationSnapshot["usage"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const total =
    typeof usage.total === "object" && usage.total !== null
      ? (usage.total as Record<string, unknown>)
      : undefined;
  const last =
    typeof usage.last === "object" && usage.last !== null
      ? (usage.last as Record<string, unknown>)
      : undefined;
  const inputTokens = safeUsageCount(total?.inputTokens);
  const outputTokens = safeUsageCount(total?.outputTokens);
  const cacheReadTokens = safeUsageCount(total?.cachedInputTokens);
  const cacheWriteTokens = safeUsageCount(total?.cacheWriteInputTokens);
  const usedTokens = safeUsageCount(last?.totalTokens);
  const maxTokens = safeUsageCount(usage.modelContextWindow);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    usedTokens === undefined &&
    maxTokens === undefined
  ) {
    return undefined;
  }
  const hasContextWindow = usedTokens !== undefined || maxTokens !== undefined;
  const codexObserved: NonNullable<ConversationSnapshot["usage"]["codexObserved"]> = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(hasContextWindow
      ? {
          contextWindow: {
            ...(usedTokens !== undefined ? { usedTokens } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          },
        }
      : {}),
  };
  return {
    // Dense fields are compatibility-only. They are emitted solely when at least one
    // corresponding native fact exists; unavailable sibling fields remain absent from
    // codexObserved and UI must mark them unavailable.
    cumulative: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: cacheReadTokens ?? 0,
      cacheWriteTokens: cacheWriteTokens ?? 0,
    },
    ...(hasContextWindow
      ? {
          contextWindow: {
            usedTokens: usedTokens ?? 0,
            maxTokens: maxTokens ?? 0,
            autoCompactThresholdTokens: null,
          },
        }
      : { contextWindow: null }),
    codexObserved,
  };
}

export class BridgeSnapshots {
  private readonly indexEpoch = randomUUID();
  private readonly configEpoch = randomUUID();
  private indexSeq = 0;
  private configSeq = 0;
  private readonly attachmentViews = new Map<
    string,
    { epoch: string; rows: ConversationSnapshot["rows"]["window"] }
  >();
  private readonly revertedTurns = new Map<string, Set<string>>();

  constructor(
    private readonly context: BridgeControlContext,
    private readonly store: ThreadStateStore,
    private readonly interactions: InteractionBroker,
    readonly workspaceId: string,
    private readonly attachments?: AttachmentStore,
  ) {}

  /**
   * Desktop 成功事务是文件恢复的事实来源，但原生历史不可重写。
   * 仅在投影层把同一 session/turn 标为 reverted；touch 复用既有全量快照发布，
   * 让同一 logEpoch 下的 revision/seq 变化负责失效 UI 终态缓存。
   */
  isFileChangesReverted(sessionId: string, turnId: string): boolean {
    return this.revertedTurns.get(sessionId)?.has(turnId) === true;
  }

  markFileChangesReverted(sessionId: string, turnId: string): (() => void) | undefined {
    let turns = this.revertedTurns.get(sessionId);
    if (!turns) {
      turns = new Set();
      this.revertedTurns.set(sessionId, turns);
    }
    if (turns.has(turnId)) return undefined;
    turns.add(turnId);
    // Revision/touch happens only after the mutation RPC is ready to ACK; otherwise the
    // store listener can publish a reverted snapshot before the transaction sees its ACK.
    return () => this.store.touch(sessionId);
  }

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
      apiRetry:
        state.apiRetry && state.apiRetry.turnId === object(array(state.thread.turns).at(-1)).id
          ? state.apiRetry.status
          : null,
      // 辅助对话 child：fork 继承的父历史只进模型上下文，不进 UI 投影。
      ...(state.sideChat ? { hiddenTurnIds: state.sideChat.inheritedTurnIds } : {}),
    });
    // Batch A/B 的稀疏事实边界：只有原生明确给到的非负安全整数才是观测值。
    // 旧 dense usage 字段保持缺省（UI 展示为不可用），不能把缺席/坏值归零。
    const observed = sparseNativeUsage(state.thread.tokenUsage);
    if (observed) {
      snapshot.usage = {
        ...snapshot.usage,
        cumulative: observed.cumulative,
        contextWindow: observed.contextWindow,
        codexObserved: observed.codexObserved,
      };
    }
    const idle = snapshot.control.phase !== "running";
    // 记住的显式档位优先；无记录按原生生效值推导（specs/codex-permission-modes.md）。
    snapshot.config.mode = projectThreadMode(state.thread);
    if (state.thread.collaborationMode)
      snapshot.config.planEnabled = object(state.thread.collaborationMode).mode === "plan";
    const allowed = { allowed: true as const };
    // writer-conflict 只读：另一进程持有写锁。fork 保持 idle 门禁不变（逃生通道）；
    // 其余写操作的 availability 与命令层的 deny guard 同一 reasonCode，UI 直接禁用。
    const writerConflict = state.readOnly === "writer-conflict";
    if (writerConflict) snapshot.writerConflict = { readOnly: true };
    const writerBlocked = { allowed: false as const, reasonCode: "guard.codex.writerConflict" };
    snapshot.availability = {
      ...snapshot.availability,
      fork: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      compact: writerConflict
        ? writerBlocked
        : idle
          ? allowed
          : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      switchModelConfig: writerConflict ? writerBlocked : allowed,
      queueEdit: writerConflict ? writerBlocked : allowed,
      // busy 也可用：命令层 interrupt+start 抢占（specs/codex-desktop-adapter.md）。
      sendQueuedNow: writerConflict ? writerBlocked : allowed,
    };
    for (const row of snapshot.rows.window) {
      if (idle && row.kind === "assistantText") row.actions = { canFork: true };
      if (idle && !writerConflict && row.kind === "userInput")
        row.actions = { canEdit: true, canRetry: true, editDisposition: "rewind" };
      if (row.kind === "turnHeader") {
        const turn = array(state.thread.turns)
          .map(object)
          .find((candidate) => candidate.id === row.turnId) as
          | { id: string; changes?: unknown }
          | undefined;
        if (turn) {
          const filesResult = projectTurnFileChanges(
            turn,
            this.isFileChangesReverted(id, turn.id) ? "reverted" : "active",
          );
          if (filesResult.files)
            row.fileChanges = {
              files: filesResult.files,
              additions: filesResult.additions,
              deletions: filesResult.deletions,
              state: filesResult.state,
            };
          // 行级撤销入口只描述「该轮存在可投影的文件变更」这一事实；
          // 能力门禁与 Desktop 事务所有者仍在 UI/服务层判定。
          // 运行中的轮次变更不完整，不开放撤销；已撤销的轮次不重复开放。
          if (filesResult.files > 0 && filesResult.state !== "reverted" && row.state !== "running")
            row.actions = { ...row.actions, canRewindFiles: true };
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
      // firstRowId/totalCount 必须保持全序口径：客户端以 window[0].rowId === firstRowId
      // 判定是否已到顶，跟随截尾改写会让 hasOlderRows 恒为 false，rows/range 分页、
      // 问题目录补齐与「加载更早」入口全部静默失效（specs/codex-desktop-adapter.md）。
      snapshot.rows.window = projectConversationTailWindow(snapshot.rows.window);
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
              // Plan 是独立勾选维度，保留旧 configOptions 消费方的兼容条目；
              // 权限档位目录与 composer 菜单同源（shared getCodexPermissionModes）。
              options: [
                { value: "plan", name: "Plan" },
                ...getCodexPermissionModes().map((mode) => ({
                  value: mode.id,
                  name: mode.name,
                  description: mode.description,
                })),
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
