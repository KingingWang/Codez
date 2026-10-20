import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";

export interface AcceptedGuideNotice {
  id: number;
  workspaceKey: string;
  sessionId: string;
  turnId: string;
  text: string;
  sourceCommandId: string;
}

type GuideRows = Pick<ConversationSnapshot, "rows">;

export function visibleAcceptedGuideNotices(
  notices: readonly AcceptedGuideNotice[],
  workspaceKey: string,
  sessionId: string | null | undefined,
  turnId: string | undefined,
  snapshot: GuideRows | null,
): AcceptedGuideNotice[] {
  if (!sessionId || !turnId || !snapshot) return [];
  return notices.filter((notice) => {
    if (
      notice.workspaceKey !== workspaceKey ||
      notice.sessionId !== sessionId ||
      notice.turnId !== turnId
    )
      return false;
    // Bug 原因：原生 steer 注入后生成的 userInput 没有 guided 标记；
    // 仅凭 text/rowId 猜测会留下重复提示或误消同文案。用本次已接纳命令 ID
    // 对齐 native userMessage.clientId 的权威投影，并限制在同一个 turn。
    return !snapshot.rows.window.some(
      (row) =>
        row.kind === "userInput" &&
        row.turnId === notice.turnId &&
        row.sourceCommandId === notice.sourceCommandId,
    );
  });
}

export function recordAcceptedGuideNotice(
  notices: readonly AcceptedGuideNotice[],
  options: {
    id: number;
    workspaceKey: string;
    sessionId: string;
    turnId: string;
    text: string;
    sourceCommandId: string;
    snapshot: GuideRows;
  },
): AcceptedGuideNotice[] {
  const visible = visibleAcceptedGuideNotices(
    notices,
    options.workspaceKey,
    options.sessionId,
    options.turnId,
    options.snapshot,
  );
  return [
    ...visible,
    {
      id: options.id,
      workspaceKey: options.workspaceKey,
      sessionId: options.sessionId,
      turnId: options.turnId,
      text: options.text,
      sourceCommandId: options.sourceCommandId,
    },
  ];
}
