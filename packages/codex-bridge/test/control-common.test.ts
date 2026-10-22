import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { BridgeControlContext, CodexRpcPort } from "../src/contract.js";
import { readCatalogProviderMap } from "../src/control-catalog.js";
import {
  readConfig,
  readNativePermissionDefaults,
  readPages,
} from "../src/control-common.js";
import { handleCodexNativeRequest } from "../src/request-scope.js";

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

test("concurrent readConfig, catalog/read and native model/list reads coalesce in flight and clear after settling", async () => {
  let configReadCalls = 0;
  let modelListCalls = 0;
  const configGate = Promise.withResolvers<{ config: Record<string, unknown> }>();
  const modelGate = Promise.withResolvers<{
    data: Array<{ id: string }>;
    nextCursor: null;
  }>();
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "config/read") {
        configReadCalls += 1;
        assert.deepEqual(params, { cwd: "/work", includeLayers: false });
        return configGate.promise as Promise<T>;
      }
      if (method === "model/list") {
        modelListCalls += 1;
        assert.deepEqual(params, { includeHidden: false, limit: 100 });
        return modelGate.promise as Promise<T>;
      }
      throw new Error(`unexpected method: ${method}`);
    },
    async respond() {},
    async respondError() {},
  };
  const context: BridgeControlContext = { rpc, cwd: "/work" };
  const rowSchema = z.object({ id: z.string() });

  const [cfg1, cfg2, catalogMap] = [
    readConfig(context),
    readConfig(context),
    readCatalogProviderMap(context, "catalog/read"),
  ];
  const [models1, models2, nativeModels] = [
    readPages(context, "model/list", rowSchema, { includeHidden: false }),
    readPages(context, "model/list", rowSchema, { includeHidden: false }),
    handleCodexNativeRequest(
      { method: "model/list", params: { includeHidden: false, limit: 100 } },
      context,
      async () => {},
    ),
  ];

  assert.equal(configReadCalls, 1, "in-flight config/read requests with identical params coalesce");
  assert.equal(modelListCalls, 1, "in-flight model/list requests with identical params coalesce");

  configGate.resolve({ config: { model: "gpt-5-codex", model_provider: "openai" } });
  modelGate.resolve({ data: [{ id: "m1" }], nextCursor: null });

  assert.deepEqual(await Promise.all([cfg1, cfg2, catalogMap]), [
    { model: "gpt-5-codex", model_provider: "openai" },
    { model: "gpt-5-codex", model_provider: "openai" },
    { path: null, models: [] },
  ]);
  assert.deepEqual(await Promise.all([models1, models2, nativeModels.then((r) => r.result)]), [
    [{ id: "m1" }],
    [{ id: "m1" }],
    { data: [{ id: "m1" }], nextCursor: null },
  ]);

  // settled 后必须立即释放，下一次读取重新请求权威事实，不缓存旧结果。
  await readConfig(context);
  await readPages(context, "model/list", rowSchema, { includeHidden: false });
  assert.equal(configReadCalls, 2);
  assert.equal(modelListCalls, 2);
});
