import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@codez/shared/codez-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";
import { collectBackgroundInteractionNotificationPayloads } from "./taskNotificationOrchestrator.js";

const formatMessage = ((descriptor: { id: string }, values?: { title?: string }) =>
  values?.title
    ? `${descriptor.id}: ${values.title}`
    : descriptor.id) as IntlInstance["formatMessage"];

function session(
  sessionId: string,
  interactionId?: string,
  kind: "permission" | "userInput" = "userInput",
  toolName = "AskUserQuestion",
): SessionSummary {
  return {
    sessionId,
    workspaceId: "workspace",
    title: `Task ${sessionId}`,
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    ...(interactionId ? { pendingInteraction: { interactionId, kind, toolName } } : {}),
    lastActivityAt: 1,
    createdAt: 1,
  };
}

test("后台会话新问题发一次提醒，重播和当前会话不提醒", () => {
  const waiting = session("A", "ask-1");
  const previous = new Map([
    ["A", session("A")],
    ["B", session("B")],
  ]);
  const collect = (sessions: SessionSummary[], activeTaskId = "B") =>
    collectBackgroundInteractionNotificationPayloads({
      previousBySessionId: previous,
      sessions,
      activeTaskId,
      viewingActiveTask: true,
      formatMessage,
    });

  assert.deepEqual(collect([waiting, session("B")]), [
    {
      taskId: "A",
      requestId: "ask-1",
      status: "elicitation_request",
      title: "notification.inputRequired",
      body: "notification.taskWithTitle: Task A",
    },
  ]);
  assert.deepEqual(collect([session("B", "ask-2")]), []);
  assert.deepEqual(
    collectBackgroundInteractionNotificationPayloads({
      previousBySessionId: new Map<string, SessionSummary>(),
      sessions: [waiting],
      activeTaskId: "B",
      viewingActiveTask: true,
      formatMessage,
    }),
    [
      {
        taskId: "A",
        requestId: "ask-1",
        status: "elicitation_request",
        title: "notification.inputRequired",
        body: "notification.taskWithTitle: Task A",
      },
    ],
  );
  assert.deepEqual(
    collectBackgroundInteractionNotificationPayloads({
      previousBySessionId: new Map([["A", waiting]]),
      sessions: [waiting],
      activeTaskId: "B",
      viewingActiveTask: true,
      formatMessage,
    }),
    [],
  );
});

test("设置页覆盖当前会话时也提醒；计划确认和权限使用不同文案", () => {
  const previous = new Map([["A", session("A")]]);
  const plan = collectBackgroundInteractionNotificationPayloads({
    previousBySessionId: previous,
    sessions: [session("A", "plan-1", "userInput", "ExitPlanMode")],
    activeTaskId: "A",
    viewingActiveTask: false,
    formatMessage,
  });
  assert.equal(plan[0]?.title, "notification.planApprovalRequired");
  assert.equal(plan[0]?.requestId, "plan-1");
  const permission = collectBackgroundInteractionNotificationPayloads({
    previousBySessionId: previous,
    sessions: [session("A", "permission-1", "permission", "Bash")],
    activeTaskId: "B",
    viewingActiveTask: true,
    formatMessage,
  });
  assert.equal(permission[0]?.title, "notification.permissionRequired");
});
