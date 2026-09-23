import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  V4_WIRE_PROTOCOL_VERSION,
  sessionsIndexTopic,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
} from "@codez/shared/codez-protocol-v4";
import { Emitter } from "@codez/rpc";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createCodezTaskIndexSyncer } from "../src/codez-agent/codezTaskIndexSyncer.js";
import type {
  ICodezAgentService,
  CodezAgentWorkspaceTarget,
} from "../src/codez-agent/codezAgent.js";

interface HarnessOptions {
  taskIndexRepo: TaskIndexRepo;
  workspace: CodezAgentWorkspaceTarget;
  summaries: SessionSummary[];
}

interface ListChangedEvent {
  taskId?: string;
  reason: string;
  unreadSignal?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

function summary(sessionId: string, phase: SessionSummary["phase"]): SessionSummary {
  return {
    sessionId,
    workspaceId: "remote-workspace",
    title: `CLI session ${sessionId}`,
    phase,
    sessionEnded: phase !== "running",
    hasBackgroundWork: false,
    lastActivityAt: 42,
    createdAt: 10,
  };
}

function snapshot(summaries: SessionSummary[]): SessionsIndexTopicFrame["payload"] {
  return {
    kind: "snapshot",
    snapshot: {
      protocolVersion: 1,
      workspaceId: "remote-workspace",
      logEpoch: "e",
      sessions: summaries,
    },
  };
}

async function createHarness(options: HarnessOptions) {
  const indexFrameEmitter = new Emitter<SessionsIndexTopicWireCandidate>();
  const configFrameEmitter = new Emitter<unknown>();
  const listEvents: ListChangedEvent[] = [];
  const targetTopic = sessionsIndexTopic(
    options.workspace.workspaceIdentity ?? options.workspace.workspacePath,
  );
  let subscriptionSequence = 0;
  const readSessionCalls: Error[] = [];
  const terminalEvents: string[] = [];
  const readyEvents: string[] = [];
  const agentService = {
    async subscribeSessionsIndexV4() {
      subscriptionSequence += 1;
      return {
        ack: { subscriptionId: `sub-${subscriptionSequence}`, mode: "snapshot", logEpoch: "e" },
      };
    },
    async subscribeWorkspaceConfigV4() {
      return { ack: { subscriptionId: "config-sub", mode: "snapshot", logEpoch: "e" } };
    },
    async unsubscribeSessionsIndexV4() {},
    async resyncSessionsIndexV4() {
      throw new Error("unexpected sessions-index resync");
    },
    async resyncWorkspaceConfigV4() {
      throw new Error("unexpected workspace-config resync");
    },
    async readSession() {
      readSessionCalls.push(new Error("readSession must not be called"));
      throw new Error("unexpected readSession");
    },
    async unsubscribeWorkspaceConfigV4() {},
    onDynamicSessionsIndexFrame(
      _workspace: CodezAgentWorkspaceTarget,
    ): ReturnType<ICodezAgentService["onDynamicSessionsIndexFrame"]> {
      return indexFrameEmitter.event;
    },
    onDynamicWorkspaceConfigFrame(
      _workspace: CodezAgentWorkspaceTarget,
    ): ReturnType<ICodezAgentService["onDynamicWorkspaceConfigFrame"]> {
      return configFrameEmitter.event as unknown as ReturnType<
        ICodezAgentService["onDynamicWorkspaceConfigFrame"]
      >;
    },
  } as unknown as ICodezAgentService;
  const syncer = createCodezTaskIndexSyncer({
    agentService,
    taskIndexRepo: options.taskIndexRepo,
  });
  syncer.onSessionTerminalEvent((event) => terminalEvents.push(event.kind));
  syncer.onSessionReadyEvent((event) => readyEvents.push(event.reason));
  syncer.onDynamicWorkspaceEvent(options.workspace)((event) => {
    if (event.type === "workspace_task_list_changed") {
      listEvents.push({
        taskId: event.taskId,
        reason: event.reason,
        unreadSignal: event.unreadSignal,
        workspacePath: event.workspacePath,
        workspaceIdentity: event.workspaceIdentity,
      });
    }
  });
  const sendFrame = async (
    deliveryKind: "initial" | "online" | "recovery",
    payload: SessionsIndexTopicFrame["payload"],
    sequence: number,
  ) => {
    const subscriptionId = "sub-1";
    const frame: SessionsIndexTopicFrame = {
      topic: targetTopic,
      subscriptionId,
      fromSeq: 0,
      toSeq: sequence,
      sentAt: 1,
      payload,
    };
    indexFrameEmitter.fire({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind,
      logicalFrameId: `frame-${sequence}`,
      logicalFrameOrdinal: sequence,
      topic: targetTopic,
      subscriptionId,
      frame,
    });
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const sendInitialSnapshot = async () => {
    syncer.ensureWorkspaceSubscription(options.workspace);
    await new Promise((resolve) => setImmediate(resolve));
    await sendFrame("initial", snapshot(options.summaries), 1);
  };
  return {
    agentService,
    listEvents,
    readSessionCalls,
    readyEvents,
    sendFrame,
    sendInitialSnapshot,
    syncer,
    terminalEvents,
  };
}

test("initial discovery commits missing rows then emits one scoped invalidation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const workspace = { workspacePath: "/remote/project", workspaceIdentity: "ssh:remote-a" };
  await repo.syncTaskMeta({
    meta: {
      taskId: "cli-existing",
      traceId: "codez-cli-existing",
      title: "Custom title",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      createdAt: 1,
      updatedAt: 2,
      mode: "build",
      titleOverridden: true,
      unreadAt: 123,
    },
  });
  await repo.updateTaskState({
    ...workspace,
    taskId: "cli-existing",
    patch: {
      pinned: true,
      archived: true,
      deleted: true,
      titleOverridden: true,
      updatedAt: 3,
    },
  });
  const harness = await createHarness({
    taskIndexRepo: repo,
    workspace,
    summaries: [summary("cli-existing", "completedSuccess"), summary("cli-running", "running")],
  });
  try {
    await harness.sendInitialSnapshot();

    assert.deepEqual(
      (await repo.listTaskMetas({ ...workspace, includeDeleted: true }))
        .map((meta) => meta.taskId)
        .sort(),
      ["cli-existing", "cli-running"],
    );
    assert.deepEqual(harness.readSessionCalls, []);
    assert.deepEqual(harness.terminalEvents, []);
    assert.deepEqual(harness.readyEvents, []);
    const preservedRows = await repo.listTaskMetas({ ...workspace, includeDeleted: true });
    assert.equal(
      preservedRows.find((meta) => meta.taskId === "cli-existing")?.title,
      "Custom title",
    );
    const database = new DatabaseSync(join(dir, "tasks.sqlite"));
    try {
      const shellRow = database
        .prepare(
          "SELECT pinned, archived, deleted, title_overridden, unread_at FROM tasks WHERE task_id = ?",
        )
        .get("cli-existing") as Record<string, number | null>;
      assert.equal(
        JSON.stringify(shellRow),
        JSON.stringify({
          pinned: 1,
          archived: 1,
          deleted: 1,
          title_overridden: 1,
          unread_at: 123,
        }),
      );
    } finally {
      database.close();
    }
    assert.equal(harness.listEvents.length, 1);
    assert.deepEqual(harness.listEvents[0], {
      taskId: undefined,
      reason: "task_created",
      unreadSignal: undefined,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    });
  } finally {
    harness.syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("late discovered terminal summary seeds a row without loading native history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-index-warm-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const workspace = { workspacePath: "/remote/project", workspaceIdentity: "ssh:remote-b" };
  const harness = await createHarness({
    taskIndexRepo: repo,
    workspace,
    summaries: [],
  });
  try {
    await harness.sendInitialSnapshot();
    harness.listEvents.length = 0;
    await harness.sendFrame(
      "online",
      snapshot([summary("late-cli-completed", "completedSuccess")]),
      2,
    );
    assert.equal(
      (await repo.getTaskMeta({ ...workspace, taskId: "late-cli-completed" }))?.taskId,
      "late-cli-completed",
    );
    assert.deepEqual(harness.readSessionCalls, []);
    assert.deepEqual(harness.terminalEvents, []);
    assert.deepEqual(harness.readyEvents, []);
    assert.equal(harness.listEvents.length, 1);
    assert.deepEqual(harness.listEvents[0], {
      taskId: undefined,
      reason: "task_created",
      unreadSignal: undefined,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    });
    await harness.sendFrame(
      "online",
      snapshot([summary("late-cli-completed", "completedSuccess")]),
      3,
    );
    assert.equal(harness.listEvents.length, 1);
  } finally {
    harness.syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-path remote identities remain isolated during discovery", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "codez-codex-index-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "codez-codex-index-b-"));
  const firstRepo = new TaskIndexRepo(join(firstDir, "tasks.sqlite"));
  const secondRepo = new TaskIndexRepo(join(secondDir, "tasks.sqlite"));
  const firstWorkspace = { workspacePath: "/remote/project", workspaceIdentity: "ssh:first" };
  const secondWorkspace = { workspacePath: "/remote/project", workspaceIdentity: "ssh:second" };
  const first = await createHarness({
    taskIndexRepo: firstRepo,
    workspace: firstWorkspace,
    summaries: [summary("first-only", "completedSuccess")],
  });
  const second = await createHarness({
    taskIndexRepo: secondRepo,
    workspace: secondWorkspace,
    summaries: [summary("second-only", "completedSuccess")],
  });
  try {
    await first.sendInitialSnapshot();
    const firstEvents = first.listEvents.length;
    await second.sendInitialSnapshot();
    assert.equal(first.listEvents.length, firstEvents);
    assert.deepEqual(
      (await firstRepo.listTaskMetas({ ...firstWorkspace, includeDeleted: true })).map(
        (meta) => meta.taskId,
      ),
      ["first-only"],
    );
    assert.deepEqual(
      (await secondRepo.listTaskMetas({ ...secondWorkspace, includeDeleted: true })).map(
        (meta) => meta.taskId,
      ),
      ["second-only"],
    );
  } finally {
    first.syncer.disposeAll();
    second.syncer.disposeAll();
    firstRepo.close();
    secondRepo.close();
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("disposed discovery seeds do not write stale rows or broadcast", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-index-stale-"));
  const workspace = { workspacePath: "/remote/project", workspaceIdentity: "ssh:remote-c" };
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  let releaseSeedList: Array<() => void> = [];
  const harness = await createHarness({ taskIndexRepo: repo, workspace, summaries: [] });
  try {
    await harness.sendInitialSnapshot();
    harness.listEvents.length = 0;
    const late = summary("late-cli", "completedSuccess");
    let listStarted!: () => void;
    const listStartedPromise = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const originalList = repo.listTaskMetas.bind(repo);
    repo.listTaskMetas = async (params) => {
      listStarted();
      await new Promise<void>((resolve) => releaseSeedList.push(resolve));
      return originalList(params);
    };
    harness.sendFrame("online", snapshot([late]), 2).catch(() => {});
    await listStartedPromise;
    harness.syncer.disposeAll();
    const pending = [...releaseSeedList];
    releaseSeedList = [];
    pending.forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await repo.getTaskMeta({ ...workspace, taskId: "late-cli" }), null);
    assert.deepEqual(harness.listEvents, []);
  } finally {
    releaseSeedList.forEach((resolve) => resolve());
    harness.syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
