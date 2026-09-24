import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { codexQueuedSubmissionSchema } from "../../src/codex-types.js";
import { setup, sessionId, textInput } from "./commands-fixture.js";

const currentSelection = {
  providerId: "openai",
  modelId: "fixture-model",
  options: { reasoningLevel: "medium" },
};
const routes = [
  { busy: false, delivery: "queue", method: "thread/queue/add" },
  { busy: true, delivery: "queue", method: "thread/queue/add" },
  { busy: true, delivery: "guide", method: "turn/steer" },
  { busy: true, delivery: undefined, method: "turn/steer" },
] as const;

function settings(h: Awaited<ReturnType<typeof setup>>, mode = "build", planEnabled = false) {
  Object.assign(h.authority.thread, {
    sandboxPolicy:
      mode === "yolo" ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
    approvalPolicy: mode === "yolo" ? "never" : "untrusted",
    collaborationMode: {
      mode: planEnabled ? "plan" : "default",
      settings: {
        model: "fixture-model",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    },
  });
  h.store.markStarted(structuredClone(h.authority.thread));
  h.rpc.handlers.set("thread/queue/add", () => ({
    queuedSubmission: {
      id: "native-added",
      input: textInput("input"),
      clientUserMessageId: "same-settings",
    },
  }));
}

/** Executable admission spec: queue/steer cannot carry per-input settings. Compare
 * explicit intent to native effective settings; never acknowledge a silently lost change.
 * Rejection is before native mutation, not a compensating settings update or local queue.
 */
export async function verifyNativeInputIntent(t: TestContext) {
  const differences = [
    ["model", { modelSelection: { ...currentSelection, modelId: "other-model" } }],
    ["provider", { modelSelection: { ...currentSelection, providerId: "other-provider" } }],
    ["effort", { modelSelection: { ...currentSelection, options: { reasoningLevel: "high" } } }],
    ["permissions", { mode: "yolo" }],
    ["plan-mode", { mode: "plan" }],
    ["plan-enabled", { planEnabled: true }],
  ] as const;
  for (const route of routes) {
    for (const [field, change] of differences) {
      await t.test(
        `${route.busy}:${route.delivery} rejects changed ${field} before RPC`,
        async (t) => {
          const h = await setup(t, route.busy);
          settings(h);
          const before = structuredClone(h.state.thread);
          const command = h.command("sendText", {
            text: "input",
            requestedDelivery: route.delivery,
            ...change,
          });
          const ack = await h.execute(command);
          assert.equal(
            ack.status,
            "failed",
            `${field} must not silently execute with old settings`,
          );
          assert.ok(ack.message, "unsupported intent must be explained");
          assert.deepEqual(h.rpc.calls, [], "no admission/settings RPC may precede rejection");
          assert.deepEqual(h.state.thread, before);
          assert.deepEqual(
            await h.execute(command),
            ack,
            "duplicate rejection replays without RPC",
          );
          assert.deepEqual(h.rpc.calls, []);
        },
      );
    }
    await t.test(
      `${route.busy}:${route.delivery} accepts identical explicit settings`,
      async (t) => {
        const h = await setup(t, route.busy);
        settings(h);
        const ack = await h.execute(
          h.command(
            "sendText",
            {
              text: "input",
              requestedDelivery: route.delivery,
              modelSelection: currentSelection,
              mode: "build",
              planEnabled: false,
            },
            "same-settings",
          ),
        );
        assert.equal(ack.status, "accepted", ack.message);
        assert.deepEqual(h.rpc.params(route.method), [
          {
            threadId: sessionId,
            input: textInput("input"),
            clientUserMessageId: "same-settings",
            ...(route.method === "turn/steer" ? { expectedTurnId: "live-turn" } : {}),
          },
        ]);
        assert.deepEqual(
          h.rpc.methods(),
          route.method === "turn/steer"
            ? ["turn/steer"]
            : ["thread/queue/add", "thread/queue/list"],
        );
      },
    );
  }
  for (const [mode, planEnabled] of [
    ["yolo", false],
    ["plan", true],
  ] as const) {
    await t.test(`guide retains matching ${mode} but rejects explicit downgrade`, async (t) => {
      const h = await setup(t, true);
      settings(h, mode, planEnabled);
      const same = await h.execute(
        h.command(
          "sendText",
          {
            text: "same",
            mode,
            planEnabled,
            requestedDelivery: "guide",
            modelSelection: currentSelection,
          },
          "same-mode",
        ),
      );
      assert.equal(same.status, "accepted", same.message);
      const before = structuredClone(h.rpc.calls);
      const different = await h.execute(
        h.command(
          "sendText",
          {
            text: "different",
            mode: "build",
            planEnabled: false,
            requestedDelivery: "guide",
          },
          "change-mode",
        ),
      );
      assert.equal(different.status, "failed");
      assert.deepEqual(h.rpc.calls, before, "downgrade cannot be silently ignored");
    });
  }
  await verifyHeldIntent(t);
  await verifyQueueTextEdit(t);
}

async function verifyHeldIntent(t: TestContext) {
  for (const heldQueueDisposition of ["clearQueueAndSend", "keepQueueAndSend"] as const) {
    for (const requestedDelivery of ["startNow", "queue", "guide"] as const) {
      await t.test(
        `held item guard ${heldQueueDisposition}:${requestedDelivery} rejects`,
        async (t) => {
          const h = await setup(t, requestedDelivery === "guide");
          settings(h);
          const before = structuredClone(h.authority.queue);
          const ack = await h.execute(
            h.command("sendText", {
              text: "input",
              requestedDelivery,
              heldQueueDisposition,
              expectedHeldQueueItemIds: ["q1", "q2"],
            }),
          );
          assert.equal(ack.status, "failed", "native queue has no held/clear-and-send transaction");
          assert.ok(ack.message);
          assert.deepEqual(h.rpc.calls, [], "do not clear, start, enqueue, or steer a held intent");
          assert.deepEqual(h.authority.queue, before);
        },
      );
    }
    // 裸 heldQueueDisposition（无 item guard）无可执行事务：legacy 仅在 held(choice)
    // 路由消费它，Codex 投影永不报 choice。replayable（Bot/Automation/手机）发送端
    // 无条件携带 keepQueueAndSend 对齐旧 session/send 语义，bridge 必须接受并忽略，
    // 按默认 delivery 正常送达。
    await t.test(`bare ${heldQueueDisposition} is ignored when idle`, async (t) => {
      const h = await setup(t, false);
      settings(h);
      const ack = await h.execute(
        h.command(
          "sendText",
          { text: "input", heldQueueDisposition },
          `held-${heldQueueDisposition}`,
        ),
      );
      assert.equal(ack.status, "accepted", ack.message);
      assert.equal(h.rpc.params("turn/start").length, 1);
      assert.equal(h.rpc.params("thread/queue/add").length, 0);
      assert.equal(h.rpc.params("turn/steer").length, 0);
    });
    await t.test(`bare ${heldQueueDisposition} is ignored while running`, async (t) => {
      const h = await setup(t, true);
      settings(h);
      const ack = await h.execute(
        h.command(
          "sendText",
          { text: "input", heldQueueDisposition },
          `held-${heldQueueDisposition}`,
        ),
      );
      assert.equal(ack.status, "accepted", ack.message);
      assert.deepEqual(h.rpc.methods(), ["turn/steer"]);
    });
  }
}

async function verifyQueueTextEdit(t: TestContext) {
  for (const newText of ["Replacement\n  preserve spaces", ""]) {
    await t.test(
      `editQueueItem preserves native media with ${newText ? "replacement" : "empty"} text`,
      async (t) => {
        const h = await setup(t);
        const nonText = [
          { type: "image", detail: null, url: "data:image/png;base64,aGVsbG8=" },
          { type: "localImage", path: "/fixture/original.png" },
          { type: "mention", name: "context", path: "/fixture/context.md" },
          { type: "skill", name: "fixture", path: "/fixture/SKILL.md" },
        ];
        let item = codexQueuedSubmissionSchema.parse({
          id: "external-native",
          clientUserMessageId: "external-command",
          input: [
            ...textInput("Old text"),
            nonText[0],
            ...textInput("More old text"),
            ...nonText.slice(1),
          ],
        });
        // Cached queue is intentionally stale: the native list owns newer externally added media.
        h.state.queue = [{ ...item, input: textInput("Stale text-only cache") }];
        h.rpc.handlers.set("thread/queue/list", () => ({ data: [item], nextCursor: null }));
        h.rpc.handlers.set("thread/queue/update", (params) => {
          item = codexQueuedSubmissionSchema.parse({ ...item, input: params.input });
          return { queuedSubmission: item };
        });
        const command = h.command("editQueueItem", { queueItemId: item.id, newText });
        const ack = await h.execute(command);
        assert.equal(ack.status, "accepted", ack.message);
        assert.deepEqual(h.rpc.methods(), [
          "thread/queue/list",
          "thread/queue/update",
          "thread/queue/list",
        ]);
        assert.deepEqual(h.rpc.params("thread/queue/update"), [
          {
            threadId: sessionId,
            queuedSubmissionId: item.id,
            input: [...(newText ? textInput(newText) : []), ...nonText],
          },
        ]);
        assert.equal(item.clientUserMessageId, "external-command");
        assert.deepEqual(h.state.queue, [item]);
        assert.deepEqual(await h.execute(command), ack);
        assert.equal(h.rpc.params("thread/queue/update").length, 1);
      },
    );
  }
  await t.test("editQueueItem missing from native authority fails before update", async (t) => {
    const h = await setup(t);
    h.rpc.handlers.set("thread/queue/list", () => ({ data: [], nextCursor: null }));
    h.rpc.handlers.set("thread/queue/update", () => ({}));
    const ack = await h.execute(h.command("editQueueItem", { queueItemId: "q1", newText: "edit" }));
    assert.equal(ack.status, "failed");
    assert.deepEqual(h.rpc.methods(), ["thread/queue/list"]);
  });
}
