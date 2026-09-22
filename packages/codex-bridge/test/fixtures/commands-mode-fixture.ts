import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setup, sessionId } from "./commands-fixture.js";

const readOnly = { type: "readOnly", networkAccess: false };
const workspaceWrite = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

/** Executable permissions spec: native turn/settings fields, not a UI mode label, own
 * sandbox authority. Successful overrides affect subsequent turns; ordinary build input
 * preserves read-only policy, while leaving full access reinstates a sandbox.
 */
export async function verifySandboxTransitions(t: TestContext) {
  for (const via of ["settings", "send"] as const) {
    await t.test(`yolo then build via ${via} reinstates native sandbox`, async (t) => {
      const h = await setup(t);
      h.rpc.handlers.set("thread/settings/update", (params) => {
        Object.assign(h.authority.thread, {
          sandboxPolicy: params.sandboxPolicy,
          approvalPolicy: params.approvalPolicy,
        });
        return {};
      });
      const yolo = await h.execute(h.command("switchCollaborationMode", { mode: "yolo" }, "yolo"));
      assert.equal(yolo.status, "accepted", yolo.message);
      assert.deepEqual(h.rpc.params("thread/settings/update")[0], {
        threadId: sessionId,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "fixture-model",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.deepEqual(h.state.thread.sandboxPolicy, { type: "dangerFullAccess" });
      assert.equal(h.state.thread.approvalPolicy, "never");

      const command =
        via === "settings"
          ? h.command("switchCollaborationMode", { mode: "build" }, "build")
          : h.command("sendText", { text: "Build safely", mode: "build" }, "build");
      const build = await h.execute(command);
      assert.equal(build.status, "accepted", build.message);
      const params = h.rpc
        .params(via === "settings" ? "thread/settings/update" : "turn/start")
        .at(-1)!;
      assert.equal(params.approvalPolicy, "on-request");
      assert.deepEqual(params.sandboxPolicy, workspaceWrite);
      assert.deepEqual(h.state.thread.sandboxPolicy, workspaceWrite);
      assert.equal(h.state.thread.approvalPolicy, "on-request");
    });
  }

  await t.test("ordinary build input preserves native read-only policy", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, { sandboxPolicy: readOnly, approvalPolicy: "untrusted" });
    h.store.markStarted(structuredClone(h.authority.thread));
    const ack = await h.execute(h.command("sendText", { text: "Inspect only", mode: "build" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
    assert.equal(Object.hasOwn(params, "approvalPolicy"), false);
    assert.deepEqual(h.state.thread.sandboxPolicy, readOnly);
    assert.equal(h.state.thread.approvalPolicy, "untrusted");
    assert.deepEqual(h.rpc.methods(), ["turn/start"]);
  });

  await t.test(
    "rejected permission change never enters the effective settings cache",
    async (t) => {
      const h = await setup(t);
      Object.assign(h.authority.thread, { sandboxPolicy: readOnly, approvalPolicy: "untrusted" });
      h.store.markStarted(structuredClone(h.authority.thread));
      h.rpc.handlers.set("thread/settings/update", async () => {
        await Promise.resolve();
        throw new Error("native permission policy rejected change");
      });
      const ack = await h.execute(h.command("switchCollaborationMode", { mode: "yolo" }));
      assert.equal(ack.status, "failed");
      assert.match(ack.message ?? "", /native permission policy rejected/);
      assert.deepEqual(h.state.thread.sandboxPolicy, readOnly);
      assert.equal(h.state.thread.approvalPolicy, "untrusted");
    },
  );
}
