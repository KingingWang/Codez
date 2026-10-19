import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { projectThreadMode } from "../../src/command-input.js";
import { setup, sessionId } from "./commands-fixture.js";

const readOnly = { type: "readOnly", networkAccess: false };
const workspaceWrite = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

/** config/read 生效值（custom 档从放宽态切回时的恢复来源）。 */
function mockConfigRead(
  h: Awaited<ReturnType<typeof setup>>,
  config: Record<string, unknown> | "throw",
): void {
  h.rpc.handlers.set("config/read", () => {
    if (config === "throw") throw new Error("native config unavailable");
    return { config };
  });
}

/** Executable permissions spec（specs/codex-permission-modes.md）：显式档位（build/edit/yolo）
 * 在迁移时完整下发 approvalPolicy + approvalsReviewer + sandboxPolicy；custom 不携带覆盖，
 * 仅从放宽态切回时按 config/read 生效值恢复（读取失败回退 workspaceWrite 基线）。
 * 未迁移的重复提交不得重发覆盖，避免重置原生会话内已授权。
 */
export async function verifySandboxTransitions(t: TestContext) {
  for (const via of ["settings", "send"] as const) {
    await t.test(`yolo then build via ${via} reinstates native sandbox`, async (t) => {
      const h = await setup(t);
      h.rpc.handlers.set("thread/settings/update", (params) => {
        Object.assign(h.authority.thread, {
          sandboxPolicy: params.sandboxPolicy,
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer,
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
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.deepEqual(h.state.thread.sandboxPolicy, { type: "dangerFullAccess" });
      assert.equal(h.state.thread.approvalPolicy, "never");
      assert.equal(projectThreadMode(h.state.thread), "yolo");

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
      assert.equal(params.approvalsReviewer, "user");
      assert.deepEqual(params.sandboxPolicy, workspaceWrite);
      assert.deepEqual(h.state.thread.sandboxPolicy, workspaceWrite);
      assert.equal(h.state.thread.approvalPolicy, "on-request");
      assert.equal(projectThreadMode(h.state.thread), "build");
    });
  }

  await t.test("repeated explicit mode does not re-send permission overrides", async (t) => {
    const h = await setup(t);
    h.store.rememberMode(sessionId, "yolo");
    Object.assign(h.authority.thread, {
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
    });
    h.store.markStarted(structuredClone(h.authority.thread));
    h.store.rememberMode(sessionId, "yolo");
    const ack = await h.execute(h.command("sendText", { text: "Again", mode: "yolo" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    // 档位未迁移：不携带任何权限键，原生会话内授权保持。
    assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
    assert.equal(Object.hasOwn(params, "approvalPolicy"), false);
    assert.equal(Object.hasOwn(params, "approvalsReviewer"), false);
  });

  await t.test("custom input preserves native policy", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, { sandboxPolicy: readOnly, approvalPolicy: "untrusted" });
    h.store.markStarted(structuredClone(h.authority.thread));
    const ack = await h.execute(h.command("sendText", { text: "Inspect only", mode: "custom" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
    assert.equal(Object.hasOwn(params, "approvalPolicy"), false);
    assert.deepEqual(h.state.thread.sandboxPolicy, readOnly);
    assert.equal(h.state.thread.approvalPolicy, "untrusted");
    assert.deepEqual(h.rpc.methods(), ["turn/start"]);
  });

  await t.test("explicit build applies the build preset over inherited config", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, { sandboxPolicy: readOnly, approvalPolicy: "untrusted" });
    h.store.markStarted(structuredClone(h.authority.thread));
    const ack = await h.execute(h.command("sendText", { text: "Build it", mode: "build" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.approvalsReviewer, "user");
    assert.deepEqual(params.sandboxPolicy, workspaceWrite);
    assert.equal(projectThreadMode(h.state.thread), "build");
  });

  await t.test("edit routes approvals to the auto reviewer", async (t) => {
    const h = await setup(t);
    const ack = await h.execute(h.command("sendText", { text: "Auto approve", mode: "edit" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.approvalsReviewer, "auto_review");
    assert.deepEqual(params.sandboxPolicy, workspaceWrite);
    assert.equal(projectThreadMode(h.state.thread), "edit");
  });

  await t.test("build after edit resets the approvals reviewer", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, {
      sandboxPolicy: workspaceWrite,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    h.store.markStarted(structuredClone(h.authority.thread));
    const ack = await h.execute(h.command("sendText", { text: "Back to user", mode: "build" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    // 复位审批人：不允许只改沙箱留下 AI 代批（spec 状态所有权）。
    assert.equal(params.approvalsReviewer, "user");
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(projectThreadMode(h.state.thread), "build");
  });

  await t.test("custom restores config.toml values when leaving full access", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, {
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
    });
    h.store.markStarted(structuredClone(h.authority.thread));
    mockConfigRead(h, {
      sandbox_mode: "read-only",
      approval_policy: "on-request",
      approvals_reviewer: "user",
    });
    const ack = await h.execute(h.command("sendText", { text: "Restore", mode: "custom" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.deepEqual(params.sandboxPolicy, readOnly);
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.approvalsReviewer, "user");
    assert.ok(h.rpc.methods().includes("config/read"));
    assert.equal(projectThreadMode(h.state.thread), "custom");
  });

  await t.test(
    "custom restores config and resets the reviewer when leaving auto review",
    async (t) => {
      const h = await setup(t);
      // 放宽态由 AI 代批（approvalsReviewer:auto_review）提供，而非完全访问沙箱。
      Object.assign(h.authority.thread, {
        sandboxPolicy: workspaceWrite,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      });
      h.store.markStarted(structuredClone(h.authority.thread));
      mockConfigRead(h, {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
        approvals_reviewer: "user",
      });
      const ack = await h.execute(
        h.command("sendText", { text: "Back to custom", mode: "custom" }),
      );
      assert.equal(ack.status, "accepted", ack.message);
      const params = h.rpc.params("turn/start")[0]!;
      // 放宽态切回 custom：读 config/read，下发完整恢复三元组，approvalsReviewer 复位 user，
      // 不允许 AI 代批静默残留（spec 标签与生效权限不允许静默错位）。
      assert.ok(h.rpc.methods().includes("config/read"));
      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.approvalsReviewer, "user");
      assert.deepEqual(params.sandboxPolicy, workspaceWrite);
      // 成功后记忆 custom。
      assert.equal(projectThreadMode(h.state.thread), "custom");
    },
  );

  await t.test("custom falls back to the baseline when config/read fails", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, {
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
    });
    h.store.markStarted(structuredClone(h.authority.thread));
    mockConfigRead(h, "throw");
    const ack = await h.execute(h.command("sendText", { text: "Restore", mode: "custom" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.deepEqual(params.sandboxPolicy, workspaceWrite);
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.approvalsReviewer, "user");
  });

  await t.test("custom without a relaxed thread does not read config", async (t) => {
    const h = await setup(t);
    Object.assign(h.authority.thread, { sandboxPolicy: workspaceWrite });
    h.store.markStarted(structuredClone(h.authority.thread));
    h.store.rememberMode(sessionId, "build");
    const ack = await h.execute(h.command("sendText", { text: "Relax to config", mode: "custom" }));
    assert.equal(ack.status, "accepted", ack.message);
    const params = h.rpc.params("turn/start")[0]!;
    assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
    assert.equal(Object.hasOwn(params, "approvalPolicy"), false);
    assert.equal(h.rpc.methods().includes("config/read"), false);
    assert.equal(projectThreadMode(h.state.thread), "custom");
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
      // 失败不得记住档位：投影仍是原生生效值推导（custom）。
      assert.equal(projectThreadMode(h.state.thread), "custom");
    },
  );
}
