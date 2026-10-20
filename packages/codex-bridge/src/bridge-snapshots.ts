import { randomUUID } from "node:crypto";
import { formatModelPickerValue, getCodexPermissionModes } from "@codez/shared";
import {
  compactConversationRowForWire,
  subagentProjectionStateSchema,
  workspaceConfigSnapshotSchema,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext } from "./contract.js";
import { DeletedThreadError, type ThreadStateStore } from "./thread-state.js";
import type { InteractionBroker } from "./interactions.js";
import { readControlModelSettings, readControlPresentation } from "./control-presentation.js";
import { projectThreadMode } from "./command-input.js";
import { projectThread, projectSessionsIndex } from "./projection.js";
import { array, object } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { itemEntityId } from "./projection-rows.js";
import { codexThreadSchema, codexUserInputSchema } from "./codex-types.js";
import { projectOwnedInput } from "./native-file-projection.js";
import { projectConversationTailWindow } from "./projection-window.js";
import { subagentsStateFromRows } from "./subagent-projection.js";
import { SubagentActivitySeedScheduler } from "./subagent-activity.js";
import { sparseNativeTurnUsage, sparseNativeUsage } from "./bridge-snapshot-usage.js";
import type { AttachmentStore, AttachmentReadAuthorization } from "./attachments.js";
import { projectGoalActionAvailability, projectNativeThreadGoal } from "./thread-goal.js";

export class BridgeSnapshots {
  private readonly indexEpoch = randomUUID();
  private readonly configEpoch = randomUUID();
  private indexSeq = 0;
  private configSeq = 0;
  /** 子线程活性一次性种子调度（实现见 subagent-activity.ts；tracker 归 store 所有）。 */
  private readonly subagentActivitySeeds: SubagentActivitySeedScheduler;
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
  ) {
    this.subagentActivitySeeds = new SubagentActivitySeedScheduler({
      rpc: context.rpc,
      nativeThreadStatus: (childId) => store.nativeThreadStatus(childId),
      tracker: store.subagentActivityTracker(),
      touchParent: (parentId) => store.touch(parentId),
    });
  }

  /** 测试与诊断用：等待所有进行中的子线程活性种子完成。 */
  async whenSubagentActivitySeedsSettled(): Promise<void> {
    await this.subagentActivitySeeds.whenSettled();
  }

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
    const attachmentStore = this.attachments;
    const userProjections = new Map<string, Awaited<ReturnType<typeof projectOwnedInput>>>();
    const queueProjections = new Map<string, Awaited<ReturnType<typeof projectOwnedInput>>>();
    const nativeThread = attachmentStore ? codexThreadSchema.parse(state.thread) : undefined;
    // 原因：原生模型输入可包含多份完整内联文件，原始正文在剥离附件前可能超过 UI 单行预算。
    // 先按会话所有权逐项校验并派生展示文本，避免历史规模超过 store 的并发操作上限；
    // 再让纯投影执行行预算。只复制本次快照输入，不修改原生事实或另存队列。
    let presentationThread: unknown = state.thread;
    if (attachmentStore && nativeThread) {
      const turns: typeof nativeThread.turns = [];
      for (const turn of nativeThread.turns) {
        const items: typeof turn.items = [];
        for (const item of turn.items) {
          if (item.type !== "userMessage" || state.sideChat?.inheritedTurnIds.has(turn.id)) {
            items.push(item);
            continue;
          }
          const projected = await projectOwnedInput(
            codexUserInputSchema.array().parse(array(item.content)),
            id,
            attachmentStore,
          );
          userProjections.set(itemEntityId(turn.id, item.id), projected);
          items.push({
            ...item,
            content: [{ type: "text", text: projected.text, text_elements: [] }],
          });
        }
        turns.push({ ...turn, items });
      }
      presentationThread = { ...nativeThread, turns };
    }
    let presentationQueue: unknown[] = state.queue;
    if (attachmentStore) {
      presentationQueue = [];
      for (const entry of state.queue) {
        const source = object(entry);
        const projected = await projectOwnedInput(
          codexUserInputSchema.array().parse(array(source.input)),
          id,
          attachmentStore,
        );
        if (typeof source.id === "string") queueProjections.set(source.id, projected);
        presentationQueue.push({
          ...source,
          input: [{ type: "text", text: projected.text, text_elements: [] }],
        });
      }
    }
    const snapshot = projectThread(presentationThread, {
      workspacePath: this.store.cwd,
      workspaceId: this.workspaceId,
      logEpoch: state.epoch,
      seq: state.seq,
      revision: state.revision,
      queue: presentationQueue,
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
    const projectedGoal = projectNativeThreadGoal(state.goal);
    if (projectedGoal) snapshot.goal = projectedGoal;
    const allowed = { allowed: true as const };
    // writer-conflict 只读：另一进程持有写锁。fork 保持 idle 门禁不变（逃生通道）；
    // 其余写操作的 availability 与命令层的 deny guard 同一 reasonCode，UI 直接禁用。
    const writerConflict = state.readOnly === "writer-conflict";
    if (writerConflict) snapshot.writerConflict = { readOnly: true };
    // 子代理会话只读不设 writerConflict（那条文案语义是「被别的窗口/进程占用」），
    // 只用 availability 报禁用；reasonCode 与原生 flavor 同词，UI tooltip 直接复用。
    const readOnlyBlocked = state.readOnly
      ? {
          allowed: false as const,
          reasonCode:
            state.readOnly === "subagent-child"
              ? "guard.subagentReadOnly"
              : "guard.codex.writerConflict",
        }
      : undefined;
    snapshot.availability = {
      ...snapshot.availability,
      fork: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      compact:
        readOnlyBlocked ??
        (idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" }),
      switchModelConfig: readOnlyBlocked ?? allowed,
      queueEdit: readOnlyBlocked ?? allowed,
      // busy 也可用：命令层 interrupt+start 抢占（specs/codex-desktop-adapter.md）。
      sendQueuedNow: readOnlyBlocked ?? allowed,
      ...projectGoalActionAvailability(projectedGoal, readOnlyBlocked),
    };
    // 子代理下钻（specs/codex-desktop-subagent-drilldown.md）：running/ended 从已投影的
    // subagent 行派生，不额外请求原生；revision 交给 store 记账，语义不变则不递增。
    // 必须在 tail window 截断前用完整 rows 计算，否则旧会话的子代理会从目录里消失。
    const subagents = subagentsStateFromRows(snapshot.rows.window, {
      isChildActive: (childThreadId) => {
        const status = this.store.nativeThreadStatus(childThreadId);
        if (status) return status.type === "active";
        // 未加载子线程退回事件/种子观测：父线程经常永远没有终态事实（v1 只在
        // wait/send_input 观测时写 agentsStates，v2 只在 Completed 时写 activity），
        // 没有这条旁路，状态面板会在子代理结束后一直计时。
        return this.store.observedThreadActive(childThreadId);
      },
    });
    this.store.noteSubagentChildren(id, subagents.childSessionIds);
    this.subagentActivitySeeds.schedule(id, subagents.running);
    snapshot.subagents = subagentProjectionStateSchema.parse({
      revision: this.store.rememberSubagents(
        id,
        JSON.stringify(subagents),
        subagents.childSessionIds.length,
      ),
      ...subagents,
    });
    if (this.attachments) {
      for (const queueItem of snapshot.queue.items) {
        const projected = queueProjections.get(queueItem.queueItemId);
        if (!projected) continue;
        queueItem.text = projected.text;
        queueItem.attachments = projected.refs;
      }
    }
    for (const row of snapshot.rows.window) {
      if (idle && row.kind === "assistantText") row.actions = { canFork: true };
      if (idle && !writerConflict && row.kind === "userInput")
        row.actions = { canEdit: true, canRetry: true, editDisposition: "rewind" };
      if (row.kind === "turnHeader") {
        const turn = array(state.thread.turns)
          .map(object)
          .find((candidate) => candidate.id === row.turnId) as
          | { id: string; changes?: unknown; tokenUsage?: unknown }
          | undefined;
        // 修复原因：快照编码的 attachments 投影会让出 await，期间 editUserQuery/compact
        // 触发的 reloadAfterHistoryChange 会把 state.thread.turns 清空；行投影来自编码前
        // 拷贝的 presentationThread，turnHeader 仍在而 turns 已空。此处用 object() 强断言
        // 会抛 "Expected a JSON object" 并使整个 bridge 连接崩溃（原生冒烟因此失败）。
        // lastTurnId 只作 tokenUsage 兜底匹配，取不到时安全降级为不可匹配。
        const lastTurnEntry = array(state.thread.turns).at(-1);
        const lastTurnId =
          lastTurnEntry && typeof lastTurnEntry === "object" && !Array.isArray(lastTurnEntry)
            ? (lastTurnEntry as { id?: unknown }).id
            : undefined;
        const rawTurnUsage =
          state.turnTokenUsage?.[row.turnId] ??
          turn?.tokenUsage ??
          (row.turnId === lastTurnId ? state.thread.tokenUsage : undefined);
        const turnUsage = sparseNativeTurnUsage(rawTurnUsage);
        if (turnUsage) {
          row.turnUsage = turnUsage;
          if (turnUsage.outputTokens !== undefined) {
            row.outputTokens = turnUsage.outputTokens;
          }
        }
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
        // entityId 仍是 turn 作用域展示键；与预投影后的唯一派生结果对应。
        const projected = userProjections.get(row.entityId ?? "");
        if (projected) {
          row.text = projected.text;
          row.attachments = projected.refs;
        }
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
      snapshot.rows.window = projectConversationTailWindow(snapshot.rows.window).map(
        compactConversationRowForWire,
      );
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
