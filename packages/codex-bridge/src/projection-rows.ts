import {
  conversationRowSchema,
  type ConversationRow,
  type PendingInteraction,
  type ToolCallRow,
} from "@codez/shared/codez-protocol-v4";
import {
  isCodexKnownItem,
  type CodexKnownItem,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type CodexUserInput,
} from "./codex-types.js";
import { assertRowBudget, projectToolInput, projectToolOutput } from "./projection-bounds.js";
import { projectNativeFileChangeDisplay } from "./native-file-change-display.js";
import {
  codexEventMarker,
  collabAgentToolCallRow,
  contextCompactionMarker,
  dynamicToolCallRow,
  functionCallOutputRow,
  imageGenerationRow,
  imageViewRow,
  isHiddenContinuationUserMessage,
  projectReasoningText,
  projectTextOrReasoningState,
  subAgentActivityMarker,
  webSearchRow,
  type RowBase,
} from "./projection-item-extras.js";
import {
  collectSubagentAggregate,
  subagentEntityId,
  subagentRow,
  turnSubagentSignature,
  type SubagentFact,
} from "./subagent-projection.js";
import {
  buildUnanchoredAutoApprovalMarkerRow,
  canAnchorAutoApprovalToToolItem,
  decorateToolRowWithAutoApproval,
  selectAnchoredAutoApprovalForItem,
  turnAutoApprovalSignature,
  type NativeAutoApprovalReviewEntry,
  type TurnAutoApprovalReviewsMap,
} from "./auto-approval-review.js";
import { codexTurnSchema } from "./codex-types.js";

/**
 * 单个已完成且无挂载交互的 CodexTurn 的纯投影行缓存（rowId 从 0 起算）。
 * 原生事件流对 inProgress turn 原地修改 items（applyNativeItemLifecycle / applyNativeItemDelta），
 * 所以只缓存终态（completed / interrupted / failed）且当前无挂载 pendingInteraction 的 turn；
 * 并且校验 cached.items === turn.items 和 cached.itemsLength === turn.items.length。
 */
const settledTurnRowsCache = new WeakMap<
  CodexTurn,
  {
    threadCreatedAt: number;
    items: CodexTurn["items"];
    itemsLength: number;
    subagentSignature: string;
    autoApprovalSignature: string;
    baseRowId: number;
    rows: ConversationRow[];
  }
>();
const parsedTurnByRaw = new WeakMap<
  object,
  { itemsRef: unknown; itemsLength: number; parsed: CodexTurn }
>();
const validatedTurns = new WeakMap<
  CodexTurn,
  { itemsRef: CodexTurn["items"]; itemsLength: number }
>();

/**
 * 已拼好的 settled 前缀行缓存（模块级单条，按前缀校验自愈）。
 *
 * 原因：流式 delta 只改末尾活动轮，但 `projectRows` 以前每帧都要逐轮取缓存再逐行 push
 * （1 万轮 ≈ 5 万行 push ≈ 5ms/帧），会话越长每帧越慢，UI 每秒十几帧就把主线程吃满。
 * 命中后只做 `settledPrefixRows.concat(activeTurnRows)`，历史部分不再逐轮逐行重跑。
 *
 * 校验项（任一不满足就从该轮起重新投影，结果与逐轮投影完全一致）：turns 前缀引用、
 * 每个 settled turn 的 items 引用与长度、`itemsView === "full"`、`status !== "inProgress"`、
 * `thread.createdAt`、`hiddenTurnIds` 引用、subagentAnchors 引用（等价于旧的每轮
 * `turnSubagentSignature`：子代理终态在后续轮收敛时锚点轮必须重投影）、以及该轮无挂载交互。
 * `rowId` 仍是全历史连续序号（前缀从 0 起算，尾部接着排），事件顺序与行内容不变。
 */
interface SettledPrefixRowsCache {
  threadCreatedAt: number;
  hiddenTurnIds: ReadonlySet<string> | undefined;
  anchorsRef: ReadonlyMap<string, ReadonlyMap<string, SubagentFact[]>> | undefined;
  turnRefs: CodexTurn[];
  itemsRefs: CodexTurn["items"][];
  itemsLengths: number[];
  autoApprovalSignatures: string[];
  /** rowStarts[i]：前 i 轮的累计行数（rowStarts[0] === 0），用于按轮边界切片前缀行。 */
  rowStarts: number[];
  /** 前缀轮 id：尾部据此做全历史唯一性校验，避免每帧重建整份 id 集合。 */
  turnIds: Set<string>;
  rows: ConversationRow[];
}

/**
 * 按「首个可见 turn」弱引用分桶：桌面端可能同时投影多个会话（父会话、子代理下钻、
 * 附件预投影线程），单条模块级缓存会在会话之间反复失效；WeakMap 让每个线程各自持有前缀，
 * 且随 turn 对象回收，不需要显式清理。
 */
const settledPrefixRowsCache = new WeakMap<object, SettledPrefixRowsCache>();

/** 无挂载交互的轮次共用同一个空数组：语义与旧的 `interactions.filter(...)` 空结果一致。 */
const NO_TURN_INTERACTIONS: readonly PendingInteraction[] = [];

/** 前缀为空时的共用空行数组，避免每次投影都分配一个临时数组。 */
const NO_TURN_ROWS: readonly ConversationRow[] = [];

/** 对单个 turn 做幂等 schema 校验：同一引用已校验且为终态时直接复用。 */
export function parseCodexTurnCached(turn: unknown): CodexTurn {
  if (turn && typeof turn === "object") {
    const rawObj = turn as { status?: unknown; items?: unknown };
    const rawItems = Array.isArray(rawObj.items) ? rawObj.items : undefined;
    if (rawObj.status !== "inProgress" && rawItems) {
      const validated = validatedTurns.get(turn as CodexTurn);
      if (
        validated &&
        validated.itemsRef === rawItems &&
        validated.itemsLength === rawItems.length
      ) {
        return turn as CodexTurn;
      }
      const cached = parsedTurnByRaw.get(turn);
      if (cached && cached.itemsRef === rawItems && cached.itemsLength === rawItems.length) {
        return cached.parsed;
      }
    }
  }
  const parsed = codexTurnSchema.parse(turn);
  if (parsed.status !== "inProgress" && turn && typeof turn === "object") {
    const rawItems = Array.isArray((turn as { items?: unknown }).items)
      ? (turn as { items: unknown[] }).items
      : parsed.items;
    parsedTurnByRaw.set(turn, {
      itemsRef: rawItems,
      itemsLength: rawItems.length,
      parsed,
    });
    validatedTurns.set(parsed, {
      itemsRef: parsed.items,
      itemsLength: parsed.items.length,
    });
  }
  return parsed;
}

/** Explicit textual fallbacks: no fake attachment refs, byte counts or MIME facts. */
export function projectInputText(input: readonly CodexUserInput[]): string {
  return input
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
        case "localImage":
          // 原生 image 可能包含整张图片的 data URL；仅显示标记，避免撑爆行预算或泄漏 sidecar 路径。
          // 可访问的 attachment refs 由 bridge 恢复，纯投影不伪造也不暴露媒体定位符。
          return "[image]";
        case "audio":
          return `[audio: ${part.url}]`;
        case "localAudio":
          return `[local audio: ${part.path}]`;
        case "skill":
          return `[skill: ${part.name} (${part.path})]`;
        case "mention":
          return `[mention: ${part.name} (${part.path})]`;
      }
    })
    .join("\n");
}

/** 展示 ID 编码原生 (turnId, itemId)，避免原生按 turn 复用 itemId 时发生碰撞。 */
export function itemEntityId(turnId: string, itemId: string): string {
  return `codex:turn:${encodeURIComponent(turnId)}:item:${encodeURIComponent(itemId)}`;
}

/** bridge 合成的 update_plan 计划卡（specs/codex-desktop-update-plan.md）；不进入原生历史。 */
interface CodexPlanUpdateItem {
  type: "planUpdate";
  id: string;
  plan: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  explanation?: string;
}

function isCodexPlanUpdateItem(
  item: CodexThreadItem,
): item is CodexThreadItem & CodexPlanUpdateItem {
  return item.type === "planUpdate" && Array.isArray((item as { plan?: unknown }).plan);
}

type ToolItem = Extract<
  CodexKnownItem,
  { type: "commandExecution" | "fileChange" | "mcpToolCall" }
>;

function toolRow(
  item: ToolItem,
  base: RowBase,
  turn: CodexTurn,
  interactions: readonly PendingInteraction[],
): ToolCallRow {
  const mcpToolName = item.type === "mcpToolCall" ? `mcp__${item.server}__${item.tool}` : undefined;
  const mcpServerPrefix = item.type === "mcpToolCall" ? `mcp__${item.server}__` : undefined;
  const approval = interactions.find(
    (interaction) =>
      interaction.payload.kind === "permission" &&
      (interaction.turnId === undefined || interaction.turnId === turn.id) &&
      (interaction.payload.toolCallId === item.id ||
        (item.type === "mcpToolCall" &&
          item.status === "inProgress" &&
          (interaction.payload.toolName === mcpToolName ||
            (mcpServerPrefix !== undefined &&
              interaction.payload.toolName === `${mcpServerPrefix}approval`)))),
  );
  let status: ToolCallRow["status"];
  if (item.status === "completed") status = "success";
  else if (item.status === "failed") status = "error";
  else if (item.status === "declined" || turn.status === "interrupted") status = "cancelled";
  else if (turn.status === "failed") status = "error";
  else status = approval ? "pendingApproval" : "running";
  const common: ToolCallRow = {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: item.type,
    status,
    inputText: "",
  };
  if (status === "pendingApproval") common.approvalInteractionId = approval?.interactionId;
  if (status === "error")
    common.error = {
      code: `codex.${item.type}.failed`,
      message:
        item.type === "mcpToolCall" && item.error
          ? item.error.message
          : (turn.error?.message ?? `Codex ${item.type} failed`),
    };
  if (item.type === "commandExecution") {
    common.toolName = "Bash";
    Object.assign(common, projectToolInput({ command: item.command, cwd: item.cwd }));
    if (item.aggregatedOutput != null) common.output = projectToolOutput(item.aggregatedOutput);
    if (item.exitCode != null && item.exitCode !== 0 && status === "success") {
      common.status = "error";
      common.error = {
        code: "codex.command.exit",
        message: `Command exited with code ${item.exitCode}`,
      };
    }
  } else if (item.type === "fileChange") {
    common.toolName = "ApplyPatch";
    Object.assign(common, projectToolInput({ changes: item.changes }));
    common.output = projectToolOutput(
      item.changes.map((change) => `${change.path}\n${change.diff}`).join("\n"),
    );
    // 原因：原生 changes 是数组，而旧 UI 摘要只识别按文件组织的 display；
    // output.text 又可能被截断，必须在桥接时从原生事实生成有界的结构化预览。
    const display = projectNativeFileChangeDisplay(item.changes);
    if (display) common.output.display = display;
  } else {
    common.toolName = mcpToolName!;
    Object.assign(common, projectToolInput(item.arguments));
    if (item.server.length <= 256 && item.tool.length <= 256)
      common.display = {
        kind: "mcp_tool",
        serverName: item.server,
        toolName: item.tool,
      };
    if (item.result != null) common.output = projectToolOutput(JSON.stringify(item.result));
  }
  // Codex does not supply tool start/end timestamps. Turn timestamps are not tool telemetry.
  return common;
}

function itemRow(
  item: CodexThreadItem,
  turn: CodexTurn,
  base: RowBase,
  interactions: readonly PendingInteraction[],
  isLastItemInTurn: boolean,
): ConversationRow {
  if (isCodexPlanUpdateItem(item)) {
    // update_plan 是一次已完成的计划事实：复用 UI 现有 todo 识别（toolName 命中
    // tool-plan-adapter）与 messageStreamShowTodos 展示门，不虚构工具输出。
    return {
      ...base,
      kind: "toolCall",
      toolCallId: item.id,
      toolName: "update_plan",
      status: "success",
      ...projectToolInput({
        ...(typeof item.explanation === "string" ? { explanation: item.explanation } : {}),
        plan: item.plan,
      }),
    };
  }
  if (!isCodexKnownItem(item)) {
    const approval = interactions.find(
      (interaction) =>
        interaction.payload.kind === "permission" &&
        interaction.payload.toolCallId === item.id &&
        (interaction.turnId === undefined || interaction.turnId === turn.id),
    );
    const nativeStatus = typeof item.status === "string" ? item.status : undefined;
    const status =
      nativeStatus === "failed" || nativeStatus === "error"
        ? "error"
        : nativeStatus === "declined" || nativeStatus === "cancelled"
          ? "cancelled"
          : nativeStatus === "completed"
            ? "success"
            : turn.status === "failed"
              ? "error"
              : turn.status === "interrupted"
                ? "cancelled"
                : turn.status === "completed"
                  ? "success"
                  : approval
                    ? "pendingApproval"
                    : "running";
    return {
      ...base,
      kind: "toolCall",
      toolCallId: item.id,
      toolName: `codex.${item.type}`,
      status,
      ...projectToolInput(item),
      output: projectToolOutput(
        `Codex ${item.type} (generic presentation; status may be turn-derived)\n${JSON.stringify(item)}`,
      ),
      ...(status === "pendingApproval" ? { approvalInteractionId: approval?.interactionId } : {}),
      ...(status === "error"
        ? {
            error: {
              code: "codex.item.failed",
              message: `Codex ${item.type} failed`,
            },
          }
        : {}),
    };
  }
  switch (item.type) {
    case "userMessage":
      return {
        ...base,
        kind: "userInput",
        text: projectInputText(item.content),
        origin: "realUser",
        // Codex 将 turn/start.clientUserMessageId 持久化成 item.clientId；它不是提交端 clientId。
        ...(item.clientId ? { sourceCommandId: item.clientId } : {}),
      };
    case "agentMessage":
    case "plan":
      return {
        ...base,
        kind: "assistantText",
        text: item.text,
        state: projectTextOrReasoningState(item.status, turn.status, isLastItemInTurn, true),
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        text: projectReasoningText(item.summary, item.content),
        state: projectTextOrReasoningState(item.status, turn.status, isLastItemInTurn, false),
      };
    case "imageView":
      return imageViewRow(item, base);
    case "webSearch":
      return webSearchRow(item, base);
    case "imageGeneration":
      return imageGenerationRow(item, base);
    case "collabAgentToolCall":
      return collabAgentToolCallRow(item, base);
    case "dynamicToolCall":
      return dynamicToolCallRow(item, base);
    case "functionCallOutput":
      return functionCallOutputRow(item, base);
    case "contextCompaction":
      // 原生 item 只有 id（core 的 ContextCompactedEvent 无载荷），来源 manual/auto 不可知，
      // 因此不走 compact marker（origin 必填会伪造来源），用 codexEvent 分隔线。
      return contextCompactionMarker(item, turn.status, base);
    case "enteredReviewMode":
      return codexEventMarker(base, "reviewEnter", item.review);
    case "exitedReviewMode":
      return codexEventMarker(base, "reviewExit", item.review);
    case "hookPrompt":
      // hook 注入的 prompt 片段（如 UserPromptSubmit hook 上下文），截断防大行。
      return codexEventMarker(
        base,
        "hookPrompt",
        item.fragments.map((fragment) => fragment.text.trim()).join("\n"),
      );
    case "subAgentActivity":
      return subAgentActivityMarker(item, base);
    case "sleep":
      return codexEventMarker(base, "sleep", `${Math.round(item.durationMs / 1000)}s`);
    default:
      return toolRow(item, base, turn, interactions);
  }
}

function projectSingleTurnRows(
  turn: CodexTurn,
  threadCreatedAt: number,
  turnInteractions: readonly PendingInteraction[],
  turnAnchors: ReadonlyMap<string, readonly SubagentFact[]> | undefined,
  turnAutoApprovalReviews: Readonly<Record<string, NativeAutoApprovalReviewEntry>> | undefined,
  baseRowId: number,
): ConversationRow[] {
  const subagentSignature = turnSubagentSignature(turnAnchors);
  const autoApprovalSignature = turnAutoApprovalSignature(turnAutoApprovalReviews);
  const canCache = turn.status !== "inProgress" && turnInteractions.length === 0;
  if (canCache) {
    const cached = settledTurnRowsCache.get(turn);
    if (
      cached &&
      cached.threadCreatedAt === threadCreatedAt &&
      cached.items === turn.items &&
      cached.itemsLength === turn.items.length &&
      cached.subagentSignature === subagentSignature &&
      cached.autoApprovalSignature === autoApprovalSignature
    ) {
      if (cached.baseRowId === baseRowId) return cached.rows;
      const rebased = cached.rows.map((row, index) => ({
        ...row,
        rowId: baseRowId + index,
      }));
      settledTurnRowsCache.set(turn, {
        ...cached,
        baseRowId,
        rows: rebased,
      });
      return rebased;
    }
  }

  const turnRows: ConversationRow[] = [];
  const createdAt = (turn.startedAt ?? threadCreatedAt) * 1000;
  const base = {
    turnId: turn.id,
    productTurnId: turn.id,
    createdAt,
    createdAtSeq: 0,
    visibility: "visible" as const,
  };
  const source = turn.items.filter(isCodexKnownItem).find((item) => item.type === "userMessage");
  const entityIds = new Set<string>();
  const visibleItemIds = new Set<string>();
  for (const item of turn.items) {
    if (isCodexKnownItem(item) && isHiddenContinuationUserMessage(item)) continue;
    visibleItemIds.add(item.id);
  }
  turnRows.push(
    assertRowBudget(
      conversationRowSchema.parse({
        ...base,
        rowId: baseRowId,
        entityId: `codex:turn:${encodeURIComponent(turn.id)}`,
        kind: "turnHeader",
        origin: "userInput",
        executionKind: "agent",
        startedAt: createdAt,
        ...(turn.completedAt != null ? { endedAt: turn.completedAt * 1000 } : {}),
        ...(source?.type === "userMessage" && source.clientId
          ? { sourceCommandId: source.clientId }
          : {}),
        state:
          turn.status === "inProgress"
            ? "running"
            : turn.status === "completed"
              ? "completedSuccess"
              : turn.status === "interrupted"
                ? "completedInterrupted"
                : "failed",
      }),
    ),
  );
  for (const [itemIndex, item] of turn.items.entries()) {
    if (entityIds.has(item.id)) {
      // 原生协议按 turn 限定 itemId；同一 turn 内重复仍表示损坏历史，必须失败。
      throw new Error(`Duplicate Codex item ID in turn ${turn.id}: ${item.id}`);
    }
    entityIds.add(item.id);
    if (isCodexKnownItem(item) && isHiddenContinuationUserMessage(item)) {
      continue;
    }
    const rawProjectedRow = itemRow(
      item,
      turn,
      {
        ...base,
        rowId: baseRowId + turnRows.length,
        entityId: itemEntityId(turn.id, item.id),
      },
      turnInteractions,
      itemIndex === turn.items.length - 1,
    );
    const anchoredReview =
      rawProjectedRow.kind === "toolCall"
        ? selectAnchoredAutoApprovalForItem(item.id, turnAutoApprovalReviews, visibleItemIds)
        : undefined;
    const decoratedRow =
      rawProjectedRow.kind === "toolCall"
        ? decorateToolRowWithAutoApproval(rawProjectedRow, anchoredReview)
        : rawProjectedRow;
    turnRows.push(assertRowBudget(conversationRowSchema.parse(decoratedRow)));
    // subagent 行紧跟锚点 item（spawn 优先）：UI 的配对要求同 turnId + parentToolCallId，
    // 配对成功后该行不单独渲染，只把「打开子会话」入口挂到 agent 卡片上。
    for (const fact of turnAnchors?.get(item.id) ?? []) {
      turnRows.push(
        assertRowBudget(
          conversationRowSchema.parse(
            subagentRow(fact, {
              ...base,
              rowId: baseRowId + turnRows.length,
              entityId: subagentEntityId(fact.childThreadId),
            }),
          ),
        ),
      );
    }
    if (turnAutoApprovalReviews) {
      for (const reviewEntry of Object.values(turnAutoApprovalReviews)
        .filter(
          (entry) =>
            entry.targetItemId === item.id &&
            !canAnchorAutoApprovalToToolItem(entry, visibleItemIds),
        )
        .toSorted((a, b) => a.ordinal - b.ordinal)) {
        turnRows.push(
          assertRowBudget(
            conversationRowSchema.parse(
              buildUnanchoredAutoApprovalMarkerRow(reviewEntry, {
                ...base,
                rowId: baseRowId + turnRows.length,
                entityId: `codex:turn:${encodeURIComponent(turn.id)}:auto-review:${encodeURIComponent(reviewEntry.reviewId)}`,
              }),
            ),
          ),
        );
      }
    }
  }
  if (turnAutoApprovalReviews) {
    for (const reviewEntry of Object.values(turnAutoApprovalReviews)
      .filter(
        (entry) =>
          (!entry.targetItemId || !visibleItemIds.has(entry.targetItemId)) &&
          !canAnchorAutoApprovalToToolItem(entry, visibleItemIds),
      )
      .toSorted((a, b) => a.ordinal - b.ordinal)) {
      turnRows.push(
        assertRowBudget(
          conversationRowSchema.parse(
            buildUnanchoredAutoApprovalMarkerRow(reviewEntry, {
              ...base,
              rowId: baseRowId + turnRows.length,
              entityId: `codex:turn:${encodeURIComponent(turn.id)}:auto-review:${encodeURIComponent(reviewEntry.reviewId)}`,
            }),
          ),
        ),
      );
    }
  }
  if (canCache) {
    settledTurnRowsCache.set(turn, {
      threadCreatedAt,
      items: turn.items,
      itemsLength: turn.items.length,
      subagentSignature,
      autoApprovalSignature,
      baseRowId,
      rows: turnRows,
    });
  }
  return turnRows;
}

/** Whole-history ordinals, not deltas. Insert/remove/reorder requires a new caller-owned epoch.
 * createdAtSeq=0 means hydrated before the live stream, never an invented event sequence.
 * Missing item/turn timestamps fall back to thread.createdAt for display only.
 */
export function projectRows(
  thread: CodexThread,
  interactions: readonly PendingInteraction[] = [],
  /** 辅助对话 child 的继承 turn：整段跳过，不进 rows（spec: codex-selection-side-chat）。 */
  hiddenTurnIds?: ReadonlySet<string>,
  autoApprovalReviews?: TurnAutoApprovalReviewsMap,
): ConversationRow[] {
  const turns = hiddenTurnIds?.size
    ? thread.turns.filter((turn) => !hiddenTurnIds.has(turn.id))
    : thread.turns;
  // 子代理事实先整体聚合：终态可能出现在锚点之后的 turn，逐 item 决策会先显示 running 再回跳。
  const subagentAnchors = collectSubagentAggregate(thread, hiddenTurnIds).anchors;
  // 交互按 turnId 建索引：旧实现每轮都 filter 一遍（O(轮数 × 交互数)），长历史下每帧白扫。
  let wildcardInteraction = false;
  const interactionTurnIds = new Set<string>();
  for (const interaction of interactions) {
    if (interaction.turnId === undefined) wildcardInteraction = true;
    else interactionTurnIds.add(interaction.turnId);
  }
  const anyInteraction = interactions.length > 0;
  const hasInteraction = (turnId: string): boolean =>
    anyInteraction && (wildcardInteraction || interactionTurnIds.has(turnId));
  const cacheKey = turns[0];
  const cachedPrefix = cacheKey ? settledPrefixRowsCache.get(cacheKey) : undefined;
  const cache =
    cachedPrefix &&
    cachedPrefix.threadCreatedAt === thread.createdAt &&
    cachedPrefix.hiddenTurnIds === hiddenTurnIds &&
    cachedPrefix.anchorsRef === subagentAnchors
      ? cachedPrefix
      : undefined;
  // 可复用的 settled 前缀长度：逐轮只比较引用与 items 引用/长度，不重跑任何行投影。
  let reusable = 0;
  if (cache) {
    const limit = Math.min(cache.turnRefs.length, turns.length);
    while (reusable < limit) {
      const turn = turns[reusable]!;
      if (
        turn !== cache.turnRefs[reusable] ||
        turn.items !== cache.itemsRefs[reusable] ||
        turn.items.length !== cache.itemsLengths[reusable]! ||
        turn.itemsView !== "full" ||
        turn.status === "inProgress" ||
        hasInteraction(turn.id) ||
        turnAutoApprovalSignature(autoApprovalReviews?.[turn.id]) !==
          cache.autoApprovalSignatures[reusable]
      ) {
        break;
      }
      reusable += 1;
    }
  }
  const shrunk = cache !== undefined && reusable < cache.turnRefs.length;
  const prefixRows =
    reusable === 0
      ? undefined
      : shrunk
        ? cache!.rows.slice(0, cache!.rowStarts[reusable]!)
        : cache!.rows;
  // 前缀轮 id 用于全历史唯一性校验；前缀缩短时必须重建，否则被挤到尾部的轮会被误判成重复。
  const prefixTurnIds =
    reusable === 0
      ? undefined
      : shrunk
        ? new Set(cache!.turnRefs.slice(0, reusable).map((turn) => turn.id))
        : cache!.turnIds;
  const tailRows: ConversationRow[] = [];
  const tailTurnIds = new Set<string>();
  const added: { turn: CodexTurn; rowCount: number; autoApprovalSignature: string }[] = [];
  let prefixLength = reusable;
  // 已复用前缀的行数是本轮 rowId 的固定基准；prefixRowCount 会把新 settled 轮算进去，
  // 两者混用会让 rowId 基准重复计数（历史越长偏移越大），必须分开记账。
  const reusedRowCount = prefixRows?.length ?? 0;
  let prefixRowCount = reusedRowCount;
  for (let index = reusable; index < turns.length; index += 1) {
    const turn = turns[index]!;
    if (turn.itemsView !== "full")
      throw new Error("Codex conversation projection requires full turn items");
    if (prefixTurnIds?.has(turn.id) || tailTurnIds.has(turn.id))
      throw new Error(`Duplicate Codex turn ID: ${turn.id}`);
    tailTurnIds.add(turn.id);
    const turnInteractions = hasInteraction(turn.id)
      ? interactions.filter(
          (interaction) => interaction.turnId === undefined || interaction.turnId === turn.id,
        )
      : NO_TURN_INTERACTIONS;
    const turnRows = projectSingleTurnRows(
      turn,
      thread.createdAt,
      turnInteractions,
      subagentAnchors.get(turn.id),
      autoApprovalReviews?.[turn.id],
      reusedRowCount + tailRows.length,
    );
    // 只有紧接已复用前缀、且同样满足 settledTurnRowsCache 条件的轮次才能并入前缀。
    if (index === prefixLength && turn.status !== "inProgress" && turnInteractions.length === 0) {
      prefixLength += 1;
      prefixRowCount += turnRows.length;
      added.push({
        turn,
        rowCount: turnRows.length,
        autoApprovalSignature: turnAutoApprovalSignature(autoApprovalReviews?.[turn.id]),
      });
    }
    for (const row of turnRows) tailRows.push(row);
  }
  const rows = prefixRows ? prefixRows.concat(tailRows) : tailRows;
  rememberSettledPrefixRows({
    threadCreatedAt: thread.createdAt,
    hiddenTurnIds,
    anchorsRef: subagentAnchors,
    cache,
    cacheKey,
    reusable,
    added,
    prefixRows,
    prefixRowCount,
    rows,
  });
  return rows;
}

/** 把本轮新 settled 的前缀写回缓存；前缀未变化（纯流式 delta）时不产生任何分配。 */
function rememberSettledPrefixRows(options: {
  threadCreatedAt: number;
  hiddenTurnIds: ReadonlySet<string> | undefined;
  anchorsRef: ReadonlyMap<string, ReadonlyMap<string, SubagentFact[]>> | undefined;
  cache: SettledPrefixRowsCache | undefined;
  cacheKey: CodexTurn | undefined;
  reusable: number;
  added: readonly { turn: CodexTurn; rowCount: number; autoApprovalSignature: string }[];
  prefixRows: readonly ConversationRow[] | undefined;
  prefixRowCount: number;
  rows: readonly ConversationRow[];
}): void {
  const { cache, reusable, added, prefixRowCount, threadCreatedAt, hiddenTurnIds, anchorsRef } =
    options;
  if (cache && reusable === cache.turnRefs.length && added.length === 0) return;
  const cacheKey = options.cacheKey;
  if (prefixRowCount === 0) {
    if (cacheKey) settledPrefixRowsCache.delete(cacheKey);
    return;
  }
  const reusedRows = options.prefixRows ?? NO_TURN_ROWS;
  // 新增前缀轮一定排在尾部行最前面，按行数切出来即可（不与返回数组共享引用）。
  const addedRows = options.rows.slice(reusedRows.length, prefixRowCount);
  let entry = reusable > 0 ? cache : undefined;
  if (entry) {
    entry.threadCreatedAt = threadCreatedAt;
    entry.hiddenTurnIds = hiddenTurnIds;
    entry.anchorsRef = anchorsRef;
    if (reusable < entry.turnRefs.length) {
      // 前缀缩短（历史被改写 / 交互挂到了更早的轮）：截断后再追加，id 集合同步重建。
      entry.turnRefs.length = reusable;
      entry.itemsRefs.length = reusable;
      entry.itemsLengths.length = reusable;
      entry.autoApprovalSignatures.length = reusable;
      entry.rowStarts.length = reusable + 1;
      entry.turnIds = new Set(entry.turnRefs.map((turn) => turn.id));
    }
  } else {
    entry = {
      threadCreatedAt,
      hiddenTurnIds,
      anchorsRef,
      turnRefs: [],
      itemsRefs: [],
      itemsLengths: [],
      autoApprovalSignatures: [],
      rowStarts: [0],
      turnIds: new Set(),
      rows: [],
    };
  }
  for (const { turn, rowCount, autoApprovalSignature } of added) {
    entry.turnRefs.push(turn);
    entry.itemsRefs.push(turn.items);
    entry.itemsLengths.push(turn.items.length);
    entry.autoApprovalSignatures.push(autoApprovalSignature);
    entry.rowStarts.push(entry.rowStarts[entry.rowStarts.length - 1]! + rowCount);
    entry.turnIds.add(turn.id);
  }
  entry.rows = reusedRows.length === 0 ? addedRows : reusedRows.concat(addedRows);
  if (cacheKey) settledPrefixRowsCache.set(cacheKey, entry);
}
