import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { stageCodexBinary } from "./codex-runtime.mjs";
import {
  createSubagentStopModel,
  startSubagentStopBridge,
} from "./codex-subagent-stop-fixture.mjs";

test(
  "CSSTOP32: pinned Codex child interrupt, root cascade and both delivery projections",
  {
    timeout: 120_000,
  },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "codez-subagent-stop-native-"));
    const codexHome = join(temporary, "codex-home");
    const workspace = join(temporary, "workspace");
    const model = createSubagentStopModel();
    let bridge;
    try {
      await mkdir(codexHome);
      await mkdir(workspace);
      model.server.listen(0, "127.0.0.1");
      await once(model.server, "listening");
      await writeFile(
        join(codexHome, "config.toml"),
        [
          'model_provider = "smoke"',
          'model = "gpt-5.2"',
          'approval_policy = "never"',
          'sandbox_mode = "danger-full-access"',
          "[features]",
          "multi_agent = true",
          "multi_agent_v2 = true",
          "[model_providers.smoke]",
          'name = "Isolated subagent stop fixture"',
          `base_url = "http://127.0.0.1:${model.server.address().port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "[analytics]",
          "enabled = false",
          "",
        ].join("\n"),
      );
      bridge = startSubagentStopBridge({
        binary: await stageCodexBinary(),
        bridge: await buildCodexBridge(),
        workspace,
        codexHome,
        stateRoot: join(temporary, "bridge-state"),
      });
      const { rpc } = bridge;
      let commandSeq = 0;
      const command = async (sessionId, type, payload) => {
        const ack = await rpc("v4/command", {
          sessionId,
          type,
          payload,
          commandId: `command-${++commandSeq}`,
          clientId: "fixture",
          issuedAt: Date.now(),
        });
        assert.equal(ack.status, "accepted", ack.message);
        return ack;
      };
      const wait = async (read, accept, message) => {
        const deadline = Date.now() + 30_000;
        let value;
        do {
          assert.deepEqual(model.errors, []);
          value = await read();
          if (accept(value)) return value;
          await delay(25);
        } while (Date.now() < deadline);
        assert.fail(`${message}: ${JSON.stringify(value)}`);
      };
      const subscribe = async (sessionId, clientMode) => {
        const result = await rpc("v4/conversation/subscribe", {
          topic: `conversation/${sessionId}`,
          connectionId: clientMode,
          clientMode,
          workspace: {
            workspacePath: workspace,
            workspaceIdentity: workspace,
            workspaceKey: workspace,
          },
        });
        const wire = await wait(
          () =>
            bridge.frames.find(
              (frame) =>
                frame.method === "v4/conversation/frame" &&
                frame.params.subscriptionId === result.ack.subscriptionId,
            )?.params,
          (value) => value !== undefined,
          "Initial subscription frame not delivered",
        );
        assert.equal(wire.kind, "complete", "small isolated fixture needs no fragmentation");
        assert.equal(wire.frame.payload.kind, "snapshot");
        return { ...result, snapshot: wire.frame.payload.snapshot };
      };
      const state = async (sessionId, mode) => (await subscribe(sessionId, mode)).snapshot;
      for (const scenario of ["CANCEL", "CASCADE"]) {
        const created = await command(null, "createSession", { workspaceId: workspace });
        const parentId = created.result.sessionId;
        await subscribe(parentId, "desktop-continuous");
        await subscribe(parentId, "web-remote-replayable");
        await command(parentId, "sendText", {
          text: `E2E_CSSTOP32_ROOT_${scenario}`,
          requestedDelivery: "startNow",
        });
        const count = scenario === "CANCEL" ? 1 : 2;
        const snapshot = await wait(
          () => state(parentId, "desktop-continuous"),
          (value) =>
            value?.backgroundWorks.length === count &&
            (scenario === "CANCEL"
              ? value.control.phase !== "running"
              : value.control.phase === "running"),
          "Native parent and child work not ready",
        );
        const childIds = snapshot.backgroundWorks.map((work) => work.childSessionId);
        await wait(
          () => model.held.filter((entry) => entry.child && !entry.closed).length,
          (value) => value === count,
          "Child model slow streams not ready",
        );
        for (const work of snapshot.backgroundWorks) {
          assert.equal(work.kind, "subagent");
          assert.equal(work.workId, work.childSessionId);
          assert.equal(work.cancellable, true);
        }
        const childView = await subscribe(childIds[0], "desktop-continuous");
        assert.equal(
          childView.snapshot.availability.switchModelConfig.reasonCode,
          "guard.subagentReadOnly",
        );
        if (scenario === "CANCEL") {
          await command(parentId, "cancelBackgroundWork", { workId: childIds[0] });
        } else {
          await command(parentId, "stop", {});
        }
        for (const childId of childIds) {
          const rows = await wait(
            async () =>
              (await rpc("v4/conversation/rowsRange", { sessionId: childId, limit: 100 })).rows,
            (value) =>
              value.some(
                (row) => row.kind === "turnHeader" && row.state === "completedInterrupted",
              ) && value.every((row) => row.kind !== "turnHeader" || row.state !== "running"),
            "Native child did not settle interrupted",
          );
          assert.ok(rows.length > 0);
        }
        for (const mode of ["desktop-continuous", "web-remote-replayable"]) {
          const ended = await wait(
            () => state(parentId, mode),
            (value) => value?.backgroundWorks.length === 0 && value.subagents.running.length === 0,
            `${mode} work did not converge`,
          );
          assert.equal(ended.subagents.endedTotal, count);
        }
        // 已结束 child 再取消仍是 accepted，不能 resume 或重放任何模型请求。
        const requestsBefore = model.requests.length;
        await command(parentId, "cancelBackgroundWork", { workId: childIds[0] });
        assert.equal(model.requests.length, requestsBefore);
        const parentRows = (
          await rpc("v4/conversation/rowsRange", { sessionId: parentId, limit: 100 })
        ).rows;
        assert.equal(
          parentRows.find((row) => row.kind === "turnHeader").state,
          scenario === "CANCEL" ? "completedSuccess" : "completedInterrupted",
        );
        // V1 collab 与 V2 activity 都是父 driver 的原生事实，V2 不保证生成 spawn 工具行。
        for (const childId of childIds)
          assert.ok(
            parentRows.some((row) => row.kind === "subagent" && row.childSessionId === childId),
            "parent driver child facts remain native history",
          );
      }
      assert.deepEqual(model.errors, []);
    } finally {
      await bridge?.close();
      model.server.closeAllConnections();
      await new Promise((resolve) => model.server.close(resolve));
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
