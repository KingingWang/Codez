import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import type { ModelSelectionView } from "@codez/provider";
import type { CodezProtocolMessage } from "@codez/shared";
import { V4_METHODS, type CommandEnvelope } from "@codez/shared/codez-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

const nativeRoutes = (["desktop", "deployed"] as const).flatMap((runtime) =>
  (["desktop-continuous", "web-remote-replayable"] as const).map((clientMode) => ({
    runtime,
    clientMode,
  })),
);
for (const { runtime, clientMode } of nativeRoutes) {
  test(`${runtime}/${clientMode} Codex forwards native intent without legacy preparation`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "codez-codex-admission-"));
    setDataBaseDir(dir);
    const previous = { ...process.env };
    delete process.env.CODEZ_AGENT_SERVER_COMMAND;
    if (runtime === "deployed") process.env.CODEZ_CODEX_BRIDGE_PATH = "/remote/codex/bridge.cjs";
    const sent: CodezProtocolMessage[] = [];
    const messages = new Emitter<CodezProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    const client = new CodezProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      async send(message) {
        sent.push(message);
        if (!("id" in message && "method" in message)) return;
        messages.fire({
          id: message.id,
          result:
            message.method === V4_METHODS.command
              ? {
                  commandId: (message.params as CommandEnvelope).commandId,
                  status: "accepted",
                  revisionAtDecision: 1,
                }
              : { independentPlanState: false },
        });
      },
      dispose() {
        messages.dispose();
        closes.dispose();
      },
    });
    t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);
    let browserLists = 0;
    let browserExecutions = 0;
    const service = createCodezAgentService({
      presentationSurface: runtime === "desktop" ? "desktop" : undefined,
      modelSelectionReadinessSource: {
        async getView() {
          assert.fail("must not consult legacy provider registry");
        },
      },
      browserControlExecutor: {
        async list() {
          browserLists += 1;
          return [{ id: "iab-test", generation: 1, type: "iab", name: "Test", capabilities: {} }];
        },
        async execute(input) {
          browserExecutions += 1;
          return input.command.method === "list"
            ? { ok: true, tabs: [], elapsedMs: 0 }
            : {
                ok: true,
                userTabs: [{ id: "user-tab", url: "https://example.com/", title: "Test" }],
                elapsedMs: 0,
              };
        },
      },
    });
    const target = {
      workspacePath: dir,
      workspaceIdentity: "native-workspace",
      ...(runtime === "deployed" ? { remoteSessionId: "remote-native" } : {}),
      clientMode,
    };
    const selection = {
      providerId: "native-only-provider",
      modelId: "native-only-model",
      options: { reasoningLevel: "high" },
    };
    const commands: CommandEnvelope[] = [
      {
        commandId: "create-plan",
        clientId: "ui",
        sessionId: null,
        issuedAt: 1,
        type: "createSession",
        payload: {
          workspaceId: target.workspaceIdentity,
          config: { mode: "build", planEnabled: true, modelSelection: selection },
          firstInput: {
            text: "Plan",
            mode: "build",
            planEnabled: true,
            modelSelection: selection,
          },
        },
      },
      ...[false, true].map(
        (planEnabled): CommandEnvelope => ({
          commandId: `send-${planEnabled}`,
          clientId: "ui",
          sessionId: "native-thread",
          issuedAt: 2,
          type: "sendText",
          payload: {
            text: "Native input",
            mode: "build",
            planEnabled,
            modelSelection: selection,
            modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
          },
        }),
      ),
      {
        commandId: "switch-plan",
        clientId: "ui",
        sessionId: "native-thread",
        issuedAt: 3,
        type: "switchCollaborationMode",
        payload: { mode: "build", planEnabled: true },
      },
    ];
    try {
      const commandsStart = sent.length;
      for (const envelope of commands) {
        const ack = await service.sendConversationCommandV4({ ...target, envelope });
        assert.equal(ack.status, "accepted");
        assert.deepEqual(sent.at(-1), {
          id: sent.length,
          method: V4_METHODS.command,
          params:
            envelope.type === "sendText"
              ? {
                  ...envelope,
                  payload: {
                    ...envelope.payload,
                    inputOrigin: clientMode === "web-remote-replayable" ? "mobile" : "desktop",
                  },
                }
              : envelope,
        });
      }
      assert.equal(
        sent.length - commandsStart,
        commands.length,
        "commands send no legacy capability or preparation requests",
      );
      // collector 会吞读取异常；必须用真实 tab 和计数器，不能靠 assert.fail 的抛错证明未调用。
      assert.equal(browserLists, 0, "native admission never collects legacy ambient context");
      assert.equal(browserExecutions, 0, "native admission never queries browser tabs");
      // Minimal registry fixture: this test exercises readiness and not model config evaluation.
      const legacyReady = createCodezAgentService({
        presentationSurface: "desktop",
        commandResolver: () => null,
        modelSelectionReadinessSource: {
          async getView() {
            return {
              revision: 1,
              providers: [{ providerId: "legacy", models: [{ modelId: "legacy-model" }] }],
            } as unknown as ModelSelectionView;
          },
        },
      });
      try {
        assert.equal(
          (await legacyReady.helloConversationV4()).capabilities.workspaceHookReview,
          true,
        );
        await assert.rejects(
          legacyReady.sendConversationCommandV4({ ...target, envelope: commands[0]! }),
          /proto.independentPlanUnsupported/,
        );
        assert.equal((sent.at(-1) as { method: string }).method, "runtime/capabilities");
      } finally {
        await legacyReady.disposeAllAndWait();
      }
    } finally {
      await service.disposeAllAndWait();
      client.dispose();
      setDataBaseDir(null);
      process.env = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
import { codezProtocolMethods } from "@codez/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

test("remote Codex createSession, legacy createSession and forkAssistant reserve task ownership before immediate subscribe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-remote-project-reserve-"));
  setDataBaseDir(dir);
  const previous = { ...process.env };
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  process.env.CODEZ_CODEX_BRIDGE_PATH = "/remote/codex/bridge.cjs";

  const hostId = "remote:server:remote-box";
  const workspacePath = "/remote/workspace";
  const workspaceIdentity = `${hostId}:${workspacePath}`;
  const taskIndexRepo = new TaskIndexRepo(undefined, hostId, join(dir, "tasks.sqlite"));
  const repo = await taskIndexRepo.getProjectRepository();
  const project = repo.saveProject({ roots: [workspacePath] });

  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  let createdCount = 0;
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if (!("id" in message && "method" in message)) return;
      if (message.method === V4_METHODS.command) {
        const envelope = message.params as CommandEnvelope;
        createdCount += 1;
        const sessionId =
          envelope.type === "forkAssistant"
            ? `native-fork-${createdCount}`
            : `native-v4-${createdCount}`;
        messages.fire({
          id: message.id,
          result: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: 1,
            result:
              envelope.type === "forkAssistant"
                ? { type: "forkAssistant", sessionId }
                : { type: "createSession", sessionId },
          },
        });
        return;
      }
      if (message.method === codezProtocolMethods.sessionCreate) {
        createdCount += 1;
        const sessionId = `native-legacy-${createdCount}`;
        messages.fire({
          id: message.id,
          result: {
            protocol: { name: "Codez Protocol", version: 1 },
            session: {
              sessionId,
              workspace: {
                workspacePath,
                workspaceIdentity,
                workspaceKey: workspaceIdentity,
              },
              sessionKind: "interactive",
              title: "New Task",
              mode: "build",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            },
            settings: {
              model: { available: [] },
              thoughtLevel: { enabled: false, available: [] },
              mode: { current: "build" },
            },
            projection: {
              sessionId,
              status: "idle",
              mode: "build",
              turnCount: 0,
              totalTokenCount: 0,
              contextUsed: 0,
              contextWindow: 0,
              pendingPermissions: [],
              activeToolCalls: [],
              backgroundJobs: [],
            },
            runtime: {
              eventSeq: 0,
              stateRevision: 0,
              pendingRequestIds: [],
            },
            messages: [],
          },
        });
        return;
      }
      if (message.method === codezProtocolMethods.sessionList) {
        const ids = (message.params as { sessionIds?: string[] }).sessionIds ?? [];
        messages.fire({
          id: message.id,
          result: {
            sessions: ids.map((sessionId) => ({
              sessionId,
              workspace: {
                workspacePath,
                workspaceIdentity,
                workspaceKey: workspaceIdentity,
              },
              sessionKind: "interactive",
              title: "New Task",
              mode: "build",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            })),
          },
        });
        return;
      }
      if (message.method === V4_METHODS.conversationSubscribe) {
        const topic = (message.params as { topic: string }).topic;
        messages.fire({
          id: message.id,
          result: {
            ack: { subscriptionId: `sub-${topic}`, mode: "snapshot", logEpoch: "epoch-1" },
          },
        });
        return;
      }
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);

  const service = createCodezAgentService({
    nativeProjectHostId: hostId,
    prepareProjectExecution: async (projectId) => {
      const found = repo.readTree({ includeTasks: false }).projects.find((p) => p.id === projectId);
      if (!found) throw new Error("project.not-found");
      return {
        projectId: found.id,
        workspacePath: found.roots[0]!.rootPath,
        additionalDirectories: found.roots.slice(1).map((r) => r.rootPath),
        hostId,
        workspaceIdentity: undefined,
      };
    },
    prepareSessionCreation: async (target) =>
      repo.reserveCreatedTask({
        task: { ...target, taskId: target.sessionId },
        projectId: target.projectId,
        additionalDirectories: target.additionalDirectories,
      }).additionalDirectories,
    resolveSessionDirectories: async (target) => {
      const directories = repo.resolveSessionDirectories({
        ...target,
        taskId: target.sessionId,
      });
      return directories.projectId === null ? undefined : directories.additionalDirectories;
    },
    resolveSessionProjectId: async (target) =>
      repo.resolveSessionDirectories({ ...target, taskId: target.sessionId }).projectId,
  });

  try {
    // 1. V4 createSession (prewarm or firstInput) reserves project ownership before returning ACK
    const createAck = await service.sendConversationCommandV4({
      workspacePath,
      workspaceIdentity,
      projectId: project.id,
      envelope: {
        commandId: "cmd-create-v4",
        clientId: "ui",
        sessionId: null,
        issuedAt: 1,
        type: "createSession",
        payload: { workspaceId: workspaceIdentity },
      },
    });
    assert.equal(createAck.status, "accepted");
    const v4SessionId =
      createAck.result?.type === "createSession" ? createAck.result.sessionId : "";
    assert.equal(v4SessionId, "native-v4-1");
    // Unsubmitted prewarm draft stays hidden from task lists (cli_created_at IS NULL)
    assert.equal(repo.readTree().tasks.length, 0);
    // Immediate subscribeConversationV4 succeeds without waiting for async sessions-index ingestion
    const v4Sub = await service.subscribeConversationV4({
      workspacePath,
      workspaceIdentity,
      sessionId: v4SessionId,
    });
    assert.equal(v4Sub.ack.subscriptionId, `sub-conversation/${v4SessionId}`);

    // 2. V4 forkAssistant inherits and reserves parent's current project ownership before returning ACK
    const forkAck = await service.sendConversationCommandV4({
      workspacePath,
      workspaceIdentity,
      envelope: {
        commandId: "cmd-fork-v4",
        clientId: "ui",
        sessionId: v4SessionId,
        issuedAt: 2,
        type: "forkAssistant",
        payload: {
          target: { rowId: 1, entityId: "turn-1:item:answer-1" },
        },
      },
    });
    assert.equal(forkAck.status, "accepted");
    const forkedSessionId =
      forkAck.result?.type === "forkAssistant" ? forkAck.result.sessionId : "";
    assert.equal(forkedSessionId, "native-fork-2");
    const forkSub = await service.subscribeConversationV4({
      workspacePath,
      workspaceIdentity,
      sessionId: forkedSessionId,
    });
    assert.equal(forkSub.ack.subscriptionId, `sub-conversation/${forkedSessionId}`);

    // 3. Legacy createSession also reserves project ownership before returning snapshot
    const legacySnapshot = await service.createSession({
      workspacePath,
      workspaceIdentity,
      projectId: project.id,
    });
    assert.equal(legacySnapshot.session.sessionId, "native-legacy-3");
    const legacySub = await service.subscribeConversationV4({
      workspacePath,
      workspaceIdentity,
      sessionId: legacySnapshot.session.sessionId,
    });
    assert.equal(
      legacySub.ack.subscriptionId,
      `sub-conversation/${legacySnapshot.session.sessionId}`,
    );
  } finally {
    await service.disposeAllAndWait();
    client.dispose();
    taskIndexRepo.close();
    setDataBaseDir(null);
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
