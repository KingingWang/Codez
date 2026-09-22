import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ModelSelectionView } from "@zcode/provider";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { V4_METHODS, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

for (const runtime of ["desktop", "deployed"] as const) {
  test(`${runtime} Codex forwards native model and independent plan intent without legacy preparation`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-codex-admission-"));
    setDataBaseDir(dir);
    const previous = { ...process.env };
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    if (runtime === "deployed") process.env.ZCODE_CODEX_BRIDGE_PATH = "/remote/codex/bridge.cjs";
    const sent: ZCodeProtocolMessage[] = [];
    const messages = new Emitter<ZCodeProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    const client = new ZCodeProtocolClient({
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
    t.mock.method(ZCodeAgentProcessManager.prototype, "getClient", async () => client);
    const service = createZCodeAgentService({
      presentationSurface: runtime === "desktop" ? "desktop" : undefined,
      modelSelectionReadinessSource: {
        async getView() {
          assert.fail("must not consult legacy provider registry");
        },
      },
      browserControlExecutor: {
        async list() {
          assert.fail("native commands must not prepare legacy browser context");
        },
        async execute() {
          assert.fail("native commands must not execute legacy browser tools");
        },
      },
    });
    const target = { workspacePath: dir, workspaceIdentity: "native-workspace" };
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
          firstInput: { text: "Plan", mode: "build", planEnabled: true, modelSelection: selection },
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
      assert.equal((await service.helloConversationV4()).capabilities.workspaceHookReview, false);
      assert.equal((await service.helloConversationV4()).capabilities.independentPlanState, true);
      for (const envelope of commands) {
        const ack = await service.sendConversationCommandV4({ ...target, envelope });
        assert.equal(ack.status, "accepted");
        assert.deepEqual(sent.at(-1), {
          id: sent.length,
          method: V4_METHODS.command,
          params: envelope,
        });
      }
      assert.equal(sent.length, commands.length, "no legacy capability or preparation requests");
      // Minimal registry fixture: this test exercises readiness and not model config evaluation.
      const legacyReady = createZCodeAgentService({
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
