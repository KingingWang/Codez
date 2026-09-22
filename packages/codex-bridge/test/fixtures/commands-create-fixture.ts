import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setup, workspaceId } from "./commands-fixture.js";

/** Executable create contract: thread/start → accepted native settings/update → ACK.
 * No synthetic first turn. Unsupported creation intent rejects before thread allocation.
 * Native response owns the effective model; only accepted settings enter the store.
 */
async function creation(t: TestContext, fullAccess = false) {
  const h = await setup(t);
  h.rpc.handlers.set("thread/start", () => ({
    thread: { ...h.authority.thread, id: "created", model: null, turns: [] },
    model: "effective-model",
    reasoningEffort: "medium",
    sandbox: fullAccess ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
    approvalPolicy: fullAccess ? "never" : "untrusted",
  }));
  h.rpc.handlers.set("thread/settings/update", () => ({}));
  return h;
}

export async function verifyCreateIntent(t: TestContext) {
  const cases = [
    { name: "thought only", config: { thought: "high" }, effort: "high" },
    { name: "plan enabled", config: { planEnabled: true }, plan: "plan" },
    { name: "explicit plan disabled", config: { planEnabled: false }, plan: "default" },
    { name: "legacy plan mode", config: { mode: "plan" }, plan: "plan" },
    { name: "yolo mode", config: { mode: "yolo" }, plan: "default", sandbox: "dangerFullAccess" },
    {
      name: "build exits inherited full access",
      config: { mode: "build" },
      plan: "default",
      sandbox: "workspaceWrite",
    },
    {
      name: "combined mode, plan and thought",
      config: { mode: "build", planEnabled: true, thought: "high" },
      plan: "plan",
      effort: "high",
    },
  ] as const;
  for (const example of cases) {
    await t.test(`empty create preserves ${example.name}`, async (t) => {
      const h = await creation(t, "sandbox" in example && example.sandbox === "workspaceWrite");
      const command = h.command(
        "createSession",
        { workspaceId, config: example.config },
        "create",
        null,
      );
      const ack = await h.execute(command);
      assert.equal(ack.status, "accepted", ack.message);
      assert.equal(ack.result?.type, "createSession");
      if (ack.result?.type !== "createSession") assert.fail("create result required");
      assert.equal(ack.result.sessionId, "created");
      assert.equal(ack.result.input, undefined);
      assert.deepEqual(h.rpc.methods(), ["thread/start", "thread/settings/update"]);
      const params = h.rpc.params("thread/settings/update")[0]!;
      assert.equal(params.threadId, "created");
      const state = h.store.get("created")!;
      assert.equal(
        state.thread.model,
        "effective-model",
        "do not replace the accepted native model",
      );
      assert.deepEqual(state.thread.turns, [], "settings must not fabricate a first turn");
      if ("effort" in example) {
        assert.equal(params.effort, example.effort);
        assert.equal(state.thread.reasoningEffort, example.effort);
      }
      if ("plan" in example) {
        const collaboration = params.collaborationMode as {
          mode: string;
          settings: { model: string; reasoning_effort: string };
        };
        assert.equal(collaboration?.mode, example.plan);
        assert.equal(collaboration.settings.model, "effective-model");
        assert.equal(
          collaboration.settings.reasoning_effort,
          "effort" in example ? example.effort : "medium",
        );
        assert.deepEqual(state.thread.collaborationMode, collaboration);
      }
      if ("sandbox" in example) {
        assert.equal((params.sandboxPolicy as { type: string })?.type, example.sandbox);
        assert.deepEqual(state.thread.sandboxPolicy, params.sandboxPolicy);
        assert.equal(
          params.approvalPolicy,
          example.sandbox === "dangerFullAccess" ? "never" : "on-request",
        );
      }
      assert.deepEqual(await h.execute(command), ack);
      assert.deepEqual(h.rpc.methods(), ["thread/start", "thread/settings/update"]);
    });
  }
  const unsupported = [
    { mcpServers: [{ name: "fixture", command: "fixture-no-exec", args: [], env: [] }] },
    { offPeakToolEnabled: true },
    { dynamicWorkflowEnabled: true },
    { config: { mode: "edit" } },
  ];
  for (const payload of unsupported) {
    for (const firstInput of [undefined, { text: "First" }]) {
      await t.test(
        `unsupported create ${Object.keys(payload)[0]} firstInput=${!!firstInput}`,
        async (t) => {
          const h = await creation(t);
          const command = h.command(
            "createSession",
            { workspaceId, ...payload, firstInput },
            "create",
            null,
          );
          const ack = await h.execute(command);
          assert.equal(
            ack.status,
            "failed",
            "unsupported intent must not create an orphan native thread",
          );
          assert.ok(ack.message);
          assert.deepEqual(
            h.rpc.calls,
            [],
            "reject before thread/start or any other native mutation",
          );
          assert.equal(h.store.get("created"), undefined);
          assert.deepEqual(await h.execute(command), ack);
          assert.deepEqual(h.rpc.calls, []);
        },
      );
    }
  }
  await t.test("empty/false unsupported flags do not block ordinary empty create", async (t) => {
    const h = await creation(t);
    const ack = await h.execute(
      h.command(
        "createSession",
        {
          workspaceId,
          mcpServers: [],
          offPeakToolEnabled: false,
          dynamicWorkflowEnabled: false,
        },
        "create",
        null,
      ),
    );
    assert.equal(ack.status, "accepted", ack.message);
    assert.deepEqual(h.rpc.methods(), ["thread/start"]);
  });
  await t.test(
    "async create settings failure is surfaced without cache update or duplicate allocation",
    async (t) => {
      const h = await creation(t);
      h.rpc.handlers.set("thread/settings/update", async () => {
        await Promise.resolve();
        throw new Error("native creation settings rejected");
      });
      const command = h.command(
        "createSession",
        { workspaceId, config: { thought: "high" } },
        "create",
        null,
      );
      const ack = await h.execute(command);
      assert.equal(ack.status, "failed");
      assert.match(ack.message ?? "", /native creation settings rejected/);
      assert.equal(h.store.get("created")?.thread.reasoningEffort, "medium");
      assert.deepEqual(await h.execute(command), ack);
      assert.deepEqual(h.rpc.methods(), ["thread/start", "thread/settings/update"]);
    },
  );
}
