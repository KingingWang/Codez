import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as s from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import { handleCatalogRequest } from "../src/control-catalog.js";
import { supportsControlMethod } from "../src/control-plane.js";

function rpcWithConfig(config: Record<string, unknown>): CodexRpcPort {
  return {
    request<T = unknown>(method: string): Promise<T> {
      assert.equal(method, "config/read", "catalog/read 只允许经 config/read 解析目录路径");
      return Promise.resolve({ config, origins: {}, layers: null } as T);
    },
    async respond() {},
    async respondError() {},
  };
}

async function fixture(catalogContent?: string) {
  const root = await mkdtemp(join(tmpdir(), "codez-catalog-"));
  const cwd = join(root, "workspace");
  const catalogPath = join(root, "catalog.json");
  if (catalogContent !== undefined) await writeFile(catalogPath, catalogContent, "utf8");
  return { root, cwd, catalogPath };
}

test("catalog/read registers on the control plane without touching the native allowlist", () => {
  assert.equal(supportsControlMethod("catalog/read"), true);
  // 原生白名单不得包含 catalog/*：codex app-server 没有目录文件 RPC。
  assert.equal(s.codexRequestMethodSchema.safeParse("catalog/read").success, false);
});

test("catalog/read returns the slug→provider mapping from the resolved catalog file", async () => {
  const f = await fixture(
    JSON.stringify({
      models: [
        { slug: "kimi-k3", provider: "ollama1", display_name: "Kimi" },
        { slug: "gpt-6-sol", provider: "openai-my" },
        { slug: "no-provider-entry" },
      ],
    }),
  );
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const result = s.codezCatalogReadResultSchema.parse(
    await handleCatalogRequest(
      "catalog/read",
      { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } },
      context,
    ),
  );
  assert.equal(result.path, f.catalogPath);
  // 只收录显式声明 provider 的条目；catalog 其他字段被剥离。
  assert.deepEqual(result.models, [
    { slug: "kimi-k3", provider: "ollama1" },
    { slug: "gpt-6-sol", provider: "openai-my" },
  ]);
});

test("catalog/read without model_catalog_json returns an empty mapping", async () => {
  const f = await fixture();
  const context = { rpc: rpcWithConfig({ model_provider: "openai" }), cwd: f.cwd };
  const result = s.codezCatalogReadResultSchema.parse(
    await handleCatalogRequest(
      "catalog/read",
      { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } },
      context,
    ),
  );
  assert.deepEqual(result, { path: null, models: [] });
});

test("catalog/read fails honestly when the configured catalog file is unreadable", async () => {
  const f = await fixture();
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: join(f.root, "missing.json") }),
    cwd: f.cwd,
  };
  await assert.rejects(
    handleCatalogRequest(
      "catalog/read",
      { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } },
      context,
    ),
    /failed to read model catalog/,
  );
  const bad = await fixture("{ not json");
  const badContext = {
    rpc: rpcWithConfig({ model_catalog_json: bad.catalogPath }),
    cwd: bad.cwd,
  };
  await assert.rejects(
    handleCatalogRequest(
      "catalog/read",
      { workspace: { workspacePath: bad.cwd, workspaceKey: bad.cwd } },
      badContext,
    ),
    /failed to parse model catalog/,
  );
});

test("catalog/read rejects foreign workspaces", async () => {
  const f = await fixture(JSON.stringify({ models: [] }));
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  await assert.rejects(
    handleCatalogRequest(
      "catalog/read",
      { workspace: { workspacePath: join(f.root, "elsewhere"), workspaceKey: "elsewhere" } },
      context,
    ),
    /Workspace does not match/,
  );
});

test("catalog read/write/delete methods register on the control plane only", () => {
  for (const method of ["catalog/readModels", "catalog/writeModel", "catalog/deleteModel"]) {
    assert.equal(supportsControlMethod(method), true);
    assert.equal(s.codexRequestMethodSchema.safeParse(method).success, false);
  }
});

test("catalog/readModels returns full raw entries and tolerates a missing file", async () => {
  const f = await fixture(
    JSON.stringify({
      models: [
        { slug: "kimi-k3", provider: "ollama1", context_window: 500000, extra: { a: 1 } },
        { slug: "gpt-6-sol", provider: "openai-my" },
      ],
    }),
  );
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const result = s.codezCatalogReadModelsResultSchema.parse(
    await handleCatalogRequest(
      "catalog/readModels",
      { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } },
      context,
    ),
  );
  assert.equal(result.path, f.catalogPath);
  // 管理面需要完整条目：能力字段原样保留（passthrough）。
  assert.deepEqual(result.models, [
    { slug: "kimi-k3", provider: "ollama1", context_window: 500000, extra: { a: 1 } },
    { slug: "gpt-6-sol", provider: "openai-my" },
  ]);

  // 已配置路径但文件尚未创建：按空目录处理，不报错。
  const missing = await fixture();
  const missingContext = {
    rpc: rpcWithConfig({ model_catalog_json: missing.catalogPath }),
    cwd: missing.cwd,
  };
  const empty = s.codezCatalogReadModelsResultSchema.parse(
    await handleCatalogRequest(
      "catalog/readModels",
      { workspace: { workspacePath: missing.cwd, workspaceKey: missing.cwd } },
      missingContext,
    ),
  );
  assert.deepEqual(empty, { path: missing.catalogPath, models: [] });
});

test("catalog/writeModel upserts by slug and persists the full entry atomically", async () => {
  const f = await fixture(
    JSON.stringify({
      models: [{ slug: "kimi-k3", provider: "ollama1", display_name: "Kimi" }],
    }),
  );
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const workspace = { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } };

  // 追加新条目。
  const appended = s.codezCatalogReadResultSchema.parse(
    await handleCatalogRequest(
      "catalog/writeModel",
      { ...workspace, model: { slug: "gpt-6-sol", provider: "openai-my", context_window: 400000 } },
      context,
    ),
  );
  assert.deepEqual(appended.models, [
    { slug: "kimi-k3", provider: "ollama1" },
    { slug: "gpt-6-sol", provider: "openai-my" },
  ]);

  // 同 slug 整条替换。
  await handleCatalogRequest(
    "catalog/writeModel",
    { ...workspace, model: { slug: "kimi-k3", provider: "ollama1", display_name: "Kimi K3" } },
    context,
  );
  const file = JSON.parse(await readFile(f.catalogPath, "utf8")) as {
    models: Record<string, unknown>[];
  };
  assert.deepEqual(file.models, [
    { slug: "kimi-k3", provider: "ollama1", display_name: "Kimi K3" },
    { slug: "gpt-6-sol", provider: "openai-my", context_window: 400000 },
  ]);
});

test("catalog/writeModel creates a missing catalog file from an empty model list", async () => {
  const f = await fixture();
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const result = s.codezCatalogReadResultSchema.parse(
    await handleCatalogRequest(
      "catalog/writeModel",
      {
        workspace: { workspacePath: f.cwd, workspaceKey: f.cwd },
        model: { slug: "first", provider: "ollama1" },
      },
      context,
    ),
  );
  assert.deepEqual(result.models, [{ slug: "first", provider: "ollama1" }]);
  const file = JSON.parse(await readFile(f.catalogPath, "utf8")) as { models: unknown[] };
  assert.deepEqual(file.models, [{ slug: "first", provider: "ollama1" }]);
});

test("catalog/writeModel requires a configured catalog path and a valid entry", async () => {
  const f = await fixture();
  const noPath = { rpc: rpcWithConfig({ model_provider: "openai" }), cwd: f.cwd };
  await assert.rejects(
    handleCatalogRequest(
      "catalog/writeModel",
      {
        workspace: { workspacePath: f.cwd, workspaceKey: f.cwd },
        model: { slug: "x", provider: "ollama1" },
      },
      noPath,
    ),
    /model_catalog_json is not configured/,
  );
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  await assert.rejects(
    handleCatalogRequest(
      "catalog/writeModel",
      { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd }, model: { provider: "ollama1" } },
      context,
    ),
  );
});

test("catalog/deleteModel removes by slug and reports missing entries honestly", async () => {
  const f = await fixture(
    JSON.stringify({
      models: [
        { slug: "kimi-k3", provider: "ollama1" },
        { slug: "gpt-6-sol", provider: "openai-my" },
      ],
    }),
  );
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const workspace = { workspace: { workspacePath: f.cwd, workspaceKey: f.cwd } };
  const result = s.codezCatalogReadResultSchema.parse(
    await handleCatalogRequest("catalog/deleteModel", { ...workspace, slug: "kimi-k3" }, context),
  );
  assert.deepEqual(result.models, [{ slug: "gpt-6-sol", provider: "openai-my" }]);
  const file = JSON.parse(await readFile(f.catalogPath, "utf8")) as { models: unknown[] };
  assert.deepEqual(file.models, [{ slug: "gpt-6-sol", provider: "openai-my" }]);

  await assert.rejects(
    handleCatalogRequest("catalog/deleteModel", { ...workspace, slug: "kimi-k3" }, context),
    /not found/,
  );
});

test("catalog write methods reject foreign workspaces", async () => {
  const f = await fixture(JSON.stringify({ models: [] }));
  const context = {
    rpc: rpcWithConfig({ model_catalog_json: f.catalogPath }),
    cwd: f.cwd,
  };
  const foreign = { workspace: { workspacePath: join(f.root, "elsewhere"), workspaceKey: "x" } };
  await assert.rejects(
    handleCatalogRequest("catalog/writeModel", { ...foreign, model: { slug: "a" } }, context),
    /Workspace does not match/,
  );
  await assert.rejects(
    handleCatalogRequest("catalog/deleteModel", { ...foreign, slug: "a" }, context),
    /Workspace does not match/,
  );
  await assert.rejects(
    handleCatalogRequest("catalog/readModels", foreign, context),
    /Workspace does not match/,
  );
});
