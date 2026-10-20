import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeControlContext, CodexRpcPort } from "../src/contract.js";
import { readNativePermissionDefaults } from "../src/control-common.js";

/** 构造 config/read 返回给定 config 的控制上下文；readNativePermissionDefaults 只依赖 rpc+cwd。 */
function contextFor(config: unknown): BridgeControlContext {
  const rpc: CodexRpcPort = {
    async request<T>(method: string): Promise<T> {
      assert.equal(method, "config/read");
      return { config } as T;
    },
    async respond() {},
    async respondError() {},
  };
  return { rpc, cwd: "/work" };
}

/** config/read reject：实现吞掉失败返回 undefined，由调用方回退 workspaceWrite 基线。 */
function throwingContext(): BridgeControlContext {
  const rpc: CodexRpcPort = {
    async request<T>(): Promise<T> {
      throw new Error("config unavailable");
    },
    async respond() {},
    async respondError() {},
  };
  return { rpc, cwd: "/work" };
}

test("readNativePermissionDefaults maps workspace-write into the v2 camelCase sandbox policy", async () => {
  const defaults = await readNativePermissionDefaults(
    contextFor({
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/repo", "/tmp/scratch"],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
      approval_policy: "on-request",
      approvals_reviewer: "user",
    }),
  );
  assert.deepEqual(defaults, {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/repo", "/tmp/scratch"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
});

test("readNativePermissionDefaults maps read-only and danger-full-access sandbox modes", async () => {
  assert.deepEqual(
    (await readNativePermissionDefaults(contextFor({ sandbox_mode: "read-only" })))?.sandboxPolicy,
    { type: "readOnly", networkAccess: false },
  );
  assert.deepEqual(
    (await readNativePermissionDefaults(contextFor({ sandbox_mode: "danger-full-access" })))
      ?.sandboxPolicy,
    { type: "dangerFullAccess" },
  );
});

test("readNativePermissionDefaults normalizes the guardian_subagent reviewer alias", async () => {
  // guardian_subagent 是 auto_review 的旧别名（serde alias），统一投影为 auto_review。
  const defaults = await readNativePermissionDefaults(
    contextFor({ approvals_reviewer: "guardian_subagent" }),
  );
  assert.deepEqual(defaults, { approvalsReviewer: "auto_review" });
});

test("readNativePermissionDefaults drops approval policies outside the bridge whitelist", async () => {
  const defaults = await readNativePermissionDefaults(
    contextFor({ sandbox_mode: "workspace-write", approval_policy: "untrusted" }),
  );
  // untrusted 不在 bridge 档位使用的两值（on-request/never）内，不透传，交由调用方基线兜底。
  assert.ok(defaults);
  assert.equal("approvalPolicy" in defaults, false);
  assert.deepEqual(defaults.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("readNativePermissionDefaults returns undefined when config/read rejects", async () => {
  assert.equal(await readNativePermissionDefaults(throwingContext()), undefined);
});
