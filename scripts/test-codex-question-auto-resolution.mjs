import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { stageCodexBinary } from "./codex-runtime.mjs";
import { startSubagentStopBridge } from "./codex-subagent-stop-fixture.mjs";
import { createQuestionAutoResolutionModel } from "./codex-question-auto-resolution-fixture.mjs";

test(
  "CSAQ34: pinned native Codex auto-continues, preserves empty-answer history and keeps disabled questions pending",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "codex-question-auto-resolution-"));
    const artifactsRoot = join(import.meta.dirname, "../packages/desktop/.e2e-artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    const artifacts = await mkdtemp(join(artifactsRoot, "codex-question-native-"));
    const codexHome = join(temporary, "codex-home"),
      workspace = join(temporary, "workspace");
    const model = createQuestionAutoResolutionModel();
    let bridge,
      commandSequence = 0;
    const evidence = { checks: [], status: "running" };
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
          "[model_providers.smoke]",
          'name = "Isolated native question fixture"',
          `base_url = "http://127.0.0.1:${model.server.address().port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "[analytics]",
          "enabled = false",
          "",
        ].join("\n"),
      );
      const binary = await stageCodexBinary(),
        bundled = await buildCodexBridge();
      const start = () =>
        startSubagentStopBridge({
          bridge: bundled,
          binary,
          workspace,
          codexHome,
          stateRoot: join(temporary, "bridge-state"),
          extraEnv: { CODEZ_ENV: "test", CODEZ_E2E_ASK_USER_QUESTION_CLOCK_SCALE: "20" },
        });
      bridge = start();
      const scope = {
        workspacePath: workspace,
        workspaceIdentity: workspace,
        workspaceKey: workspace,
      };
      const command = async (sessionId, type, payload) => {
        const ack = await bridge.rpc("v4/command", {
          sessionId,
          type,
          payload,
          commandId: `question-command-${++commandSequence}`,
          clientId: "fixture",
          issuedAt: Date.now(),
        });
        assert.ok(["accepted", "noop"].includes(ack.status), ack.message);
        return ack;
      };
      const wait = async (read, accept, message, timeout = 25_000) => {
        const deadline = Date.now() + timeout;
        let value;
        do {
          assert.deepEqual(model.errors, []);
          value = await read();
          if (accept(value)) return value;
          await delay(25);
        } while (Date.now() < deadline);
        assert.fail(`${message}: ${JSON.stringify(value)}`);
      };
      const snapshot = async (sessionId, clientMode = "desktop-continuous") => {
        const sub = await bridge.rpc("v4/conversation/subscribe", {
          topic: `conversation/${sessionId}`,
          connectionId: clientMode,
          clientMode,
          workspace: scope,
        });
        const frame = await wait(
          () =>
            bridge.frames.find((frame) => frame.params?.subscriptionId === sub.ack.subscriptionId)
              ?.params,
          (value) => !!value,
          "subscription frame missing",
        );
        assert.equal(frame.kind, "complete");
        return frame.frame.payload.snapshot;
      };
      const createQuestion = async (marker) => {
        const created = await command(null, "createSession", { workspaceId: workspace });
        const id = created.result.sessionId;
        await snapshot(id);
        await command(id, "sendText", {
          text: `E2E_CSAQ34_${marker}`,
          requestedDelivery: "startNow",
          planEnabled: true,
          mode: "yolo",
        });
        return id;
      };
      const id = await createQuestion("AUTO");
      const pending = await wait(
        () => snapshot(id),
        (value) => value.pendingInteractions.length === 1,
        "native question missing",
      );
      evidence.initialSnapshot = pending;
      assert.equal(pending.pendingInteractions[0].payload.toolName, "AskUserQuestion");
      const timing = pending.pendingInteractions[0].autoResolution;
      assert.ok(timing, "issue #34: native pending question must register its deadline");
      assert.equal(timing.visibleAt - timing.startedAt, 3_000);
      assert.equal(timing.deadlineAt - timing.startedAt, 15_000);
      const phone = await snapshot(id, "web-remote-replayable");
      assert.deepEqual(phone.pendingInteractions[0].autoResolution, timing);
      evidence.checks.push("native-deadline", "same-mobile-absolute-deadline");
      const ended = await wait(
        () => snapshot(id),
        (value) =>
          value.pendingInteractions.length === 0 && value.control.phase === "completedSuccess",
        "native empty-answer continuation missing",
      );
      assert.equal(model.continuations.length, 1);
      evidence.nativeToolResult = model.continuations[0].output;
      assert.deepEqual(JSON.parse(model.continuations[0].output), { answers: {} });
      assert.ok(
        ended.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "E2E_CSAQ34 native continued",
        ),
      );
      const ask = ended.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolName === "AskUserQuestion",
      );
      assert.ok(ask, "native question history must use the shared Ask renderer");
      assert.equal(ask.status, "success");
      assert.deepEqual(JSON.parse(ask.output.text), { answers: {} });
      assert.equal(ended.rows.window.filter((row) => row.kind === "userInput").length, 1);
      evidence.checks.push(
        "native-empty-answer-success",
        "native-model-continuation",
        "shared-ask-history",
        "no-fabricated-user-row",
      );
      await bridge.close();
      bridge = start();
      const restored = await snapshot(id);
      const restoredAsk = restored.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolName === "AskUserQuestion",
      );
      assert.deepEqual(JSON.parse(restoredAsk.output.text), { answers: {} });
      evidence.checks.push("cold-native-history");

      const preference = await bridge.rpc("workspace/updateInteractionPreferences", {
        workspace: scope,
        preferences: { askUserQuestionAutoResolutionEnabled: false },
      });
      assert.equal(preference.askUserQuestionAutoResolutionEnabled, false);
      const disabledId = await createQuestion("DISABLED");
      const disabled = await wait(
        () => snapshot(disabledId),
        (value) => value.pendingInteractions.length === 1,
        "disabled native question missing",
      );
      assert.equal(disabled.pendingInteractions[0].autoResolution, undefined);
      await bridge.rpc("workspace/updateInteractionPreferences", {
        workspace: scope,
        preferences: { askUserQuestionAutoResolutionEnabled: true },
      });
      const updated = await snapshot(disabledId, "web-remote-replayable");
      assert.equal(updated.pendingInteractions[0].autoResolution, undefined);
      await delay(15_100);
      const stillPending = await snapshot(disabledId);
      assert.equal(stillPending.pendingInteractions.length, 1);
      assert.equal(model.continuations.length, 1);
      await command(disabledId, "resolveInteraction", {
        interactionId: stillPending.pendingInteractions[0].interactionId,
        answer: { action: "accept", content: { target: ["Staging"] } },
      });
      await wait(
        () => snapshot(disabledId),
        (value) => value.control.phase === "completedSuccess",
        "normal native answer missing",
      );
      assert.deepEqual(JSON.parse(model.continuations.at(-1).output), {
        answers: { target: { answers: ["Staging"] } },
      });
      evidence.checks.push(
        "disabled-past-deadline",
        "reenable-not-retroactive",
        "normal-native-answer",
      );
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.error = error.message;
      throw error;
    } finally {
      await writeFile(join(artifacts, "results.json"), JSON.stringify(evidence, null, 2));
      console.log(`CSAQ34 native artifacts: ${artifacts}`);
      await bridge?.close();
      model.server.closeAllConnections();
      await new Promise((resolve) => model.server.close(resolve));
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
