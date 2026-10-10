import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUnchangedInputSettings,
  decorateNativeThread,
  projectThreadMode,
  rememberThreadMode,
  replaceQueuedText,
  turnMode,
  turnPermissionOverrides,
} from "../src/command-input.js";
import { formatNativeFileReference } from "../src/native-file-reference.js";

const workspaceWrite = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

test("queue text edit preserves only a verified native file reference", async () => {
  const ref = {
    ref: "codez-attachment://00000000-0000-4000-8000-000000000001",
    fileName: "archive.zip",
    mime: "application/zip",
    bytes: 4,
  };
  const marker = formatNativeFileReference({
    attachment: ref,
    path: "/private/attachments/00000000-0000-4000-8000-000000000001.data",
  });
  const queue = [
    {
      id: "q1",
      input: [
        { type: "text", text: "old" },
        { type: "text", text: marker },
      ],
    },
  ];
  assert.deepEqual(
    await replaceQueuedText(queue, "q1", "new", "thread-1", async () => [
      { type: "text", text: marker, text_elements: [] },
    ]),
    [
      { type: "text", text: "new", text_elements: [] },
      { type: "text", text: marker, text_elements: [] },
    ],
  );
  assert.deepEqual(
    await replaceQueuedText(
      [{ id: "q1", input: [{ type: "text", text: `old\n${marker}` }] }],
      "q1",
      "new",
      "thread-1",
      async () => [{ type: "text", text: marker }],
    ),
    [
      { type: "text", text: "new", text_elements: [] },
      { type: "text", text: marker, text_elements: [] },
    ],
  );
  await assert.rejects(
    replaceQueuedText(queue, "q1", "new", "thread-2", async () => []),
    /unavailable/,
  );
});

test("queue/steer cannot silently discard a changed native model or permission intent", () => {
  const thread = {
    model: "m",
    modelProvider: "p",
    reasoningEffort: "high",
    sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "default" },
  };
  // 无显式记录 → 投影 custom；同档提交放行，档位/plan/模型变更拒绝。
  assert.doesNotThrow(() =>
    assertUnchangedInputSettings(
      {
        mode: "custom",
        planEnabled: false,
        modelSelection: { modelId: "m", providerId: "p", options: { reasoningLevel: "high" } },
      },
      thread,
    ),
  );
  assert.throws(() => assertUnchangedInputSettings({ mode: "build" }, thread), /settings/);
  assert.throws(() => assertUnchangedInputSettings({ mode: "yolo" }, thread), /settings/);
  assert.throws(() => assertUnchangedInputSettings({ planEnabled: true }, thread), /settings/);
  assert.throws(
    () =>
      assertUnchangedInputSettings(
        { modelSelection: { modelId: "different", providerId: "p" } },
        thread,
      ),
    /settings/,
  );
  // 记住的显式档位是守卫事实：build 线程上同档放行、异档拒绝。
  rememberThreadMode(thread, "build");
  assert.doesNotThrow(() => assertUnchangedInputSettings({ mode: "build" }, thread));
  assert.throws(() => assertUnchangedInputSettings({ mode: "custom" }, thread), /settings/);
  // plan 输入按 collaborationMode 维度比较：线程处于 plan 时同档放行，否则视为变更。
  assert.doesNotThrow(() =>
    assertUnchangedInputSettings(
      { mode: "plan" },
      { ...thread, collaborationMode: { mode: "plan" } },
    ),
  );
  assert.throws(() => assertUnchangedInputSettings({ mode: "plan" }, thread), /settings/);
});

test("thread mode projection prefers the remembered explicit choice", () => {
  // 无记录：按原生生效值推导。
  assert.equal(projectThreadMode({}), "custom");
  assert.equal(projectThreadMode({ sandboxPolicy: { type: "workspaceWrite" } }), "custom");
  assert.equal(
    projectThreadMode({ sandboxPolicy: { type: "dangerFullAccess" } }),
    "yolo",
    "full access without a remembered choice projects yolo",
  );
  assert.equal(projectThreadMode({ approvalsReviewer: "auto_review" }), "edit");
  // 有记录：显式选择优先于生效值推导（bridge 重启前）。
  const relaxed = { sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" };
  rememberThreadMode(relaxed, "build");
  assert.equal(projectThreadMode(relaxed), "build");
  // plan/auto 不是权限档位，不进记忆。
  const thread: Record<string, unknown> = {};
  rememberThreadMode(thread, "plan");
  rememberThreadMode(thread, "auto");
  rememberThreadMode(thread, undefined);
  assert.equal(projectThreadMode(thread), "custom");
});

test("explicit permission tiers ship the full native preset on migration", () => {
  assert.deepEqual(turnPermissionOverrides("build"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: workspaceWrite,
  });
  assert.deepEqual(turnPermissionOverrides("edit"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxPolicy: workspaceWrite,
  });
  assert.deepEqual(turnPermissionOverrides("yolo"), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  // custom 无恢复来源时不携带任何覆盖（跟随 config.toml）。
  assert.deepEqual(turnPermissionOverrides("custom"), {});
  // custom 恢复：config.toml 生效值原样透传。
  assert.deepEqual(
    turnPermissionOverrides("custom", {
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "dangerFullAccess" },
    }),
    {
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  );
  // 不可映射/缺失值回退基线：workspaceWrite + on-request + user。
  assert.deepEqual(turnPermissionOverrides("custom", {}), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: workspaceWrite,
  });
  assert.deepEqual(
    turnPermissionOverrides("custom", { approvalPolicy: "untrusted" }).approvalPolicy,
    "on-request",
  );
  // 未知档位不猜测。
  assert.deepEqual(turnPermissionOverrides("auto"), {});
});

test("turnMode applies overrides only on an explicit migration", () => {
  // apply=false：即使显式档位也不携带权限键（重复提交不重置原生会话内授权）。
  const steady = turnMode("yolo", "model", false, "high", { apply: false });
  assert.equal(Object.hasOwn(steady, "sandboxPolicy"), false);
  assert.equal(Object.hasOwn(steady, "approvalPolicy"), false);
  assert.equal((steady.collaborationMode as { mode: string }).mode, "default");
  // apply=true：完整下发预设。
  const migration = turnMode("edit", "model", false, "high", { apply: true });
  assert.equal(migration.approvalPolicy, "on-request");
  assert.equal(migration.approvalsReviewer, "auto_review");
  assert.deepEqual(migration.sandboxPolicy, workspaceWrite);
  // custom 恢复路径携带 configDefaults。
  const restore = turnMode("custom", "model", undefined, undefined, {
    apply: true,
    configDefaults: { sandboxPolicy: { type: "readOnly" } },
  });
  assert.deepEqual(restore.sandboxPolicy, { type: "readOnly" });
  assert.equal(restore.approvalsReviewer, "user");
  // plan 维度独立：无权限键，仅 collaborationMode。
  const plan = turnMode("plan", "model", true, "high", { apply: true });
  assert.equal((plan.collaborationMode as { mode: string }).mode, "plan");
  assert.equal(Object.hasOwn(plan, "sandboxPolicy"), false);
  // 无 mode 且 planEnabled 未指定 → 空对象（模型/effort 走各自通道）。
  assert.deepEqual(turnMode(undefined, "model"), {});
});

test("decorateNativeThread merges top-level reviewer and collaboration mode from resume", () => {
  // 原生 resume 响应在顶层携带权限/plan 字段（Thread struct 不含）；水合必须合并，
  // 否则 auto_review 会被投影成 custom、plan 态丢失，标签与生效权限静默错位。
  const decorated = decorateNativeThread({
    thread: { id: "t1", cwd: "/work", turns: [] },
    sandbox: { type: "workspaceWrite" },
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    collaborationMode: { mode: "plan" },
    model: "effective",
    reasoningEffort: "high",
  });
  assert.equal(decorated.approvalsReviewer, "auto_review");
  assert.deepEqual(decorated.collaborationMode, { mode: "plan" });
  assert.deepEqual(decorated.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(decorated.approvalPolicy, "on-request");
  assert.equal(decorated.model, "effective");
  assert.equal(decorated.reasoningEffort, "high");
  // 水合后放宽态（AI 代批）投影为 edit，而非 custom。
  assert.equal(projectThreadMode(decorated), "edit");
  // start/fork 响应没有 collaborationMode：不得凭空捏造。
  const started = decorateNativeThread({
    thread: { id: "t2" },
    sandbox: { type: "dangerFullAccess" },
    approvalPolicy: "never",
    approvalsReviewer: "user",
  });
  assert.equal(Object.hasOwn(started, "collaborationMode"), false);
  assert.equal(started.approvalsReviewer, "user");
  assert.equal(projectThreadMode(started), "yolo");
});
