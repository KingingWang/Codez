import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    /failed to read model catalog/,
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
