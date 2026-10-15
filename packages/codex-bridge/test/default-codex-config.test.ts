import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import * as s from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import { handleCatalogRequest } from "../src/control-catalog.js";
import { createCodexProcess } from "../src/codex-process.js";
import {
  DEFAULT_CODEX_CATALOG_FILENAME,
  DEFAULT_CODEX_MODEL_SLUG,
  DEFAULT_CODEX_PROVIDER_ID,
  ensureDefaultCodexConfigFiles,
} from "../src/default-codex-config.js";

test("ensureDefaultCodexConfigFiles creates default config.toml and models.json when missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-default-codex-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const codexHome = join(root, ".codex");
  const first = await ensureDefaultCodexConfigFiles({ CODEX_HOME: codexHome });
  assert.equal(first.codexHome, codexHome);
  assert.equal(first.configPath, join(codexHome, "config.toml"));
  assert.equal(first.catalogPath, join(codexHome, DEFAULT_CODEX_CATALOG_FILENAME));
  assert.equal(first.createdConfig, true);
  assert.equal(first.createdCatalog, true);

  const parsedConfig = parseToml(await readFile(first.configPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(parsedConfig["model_provider"], DEFAULT_CODEX_PROVIDER_ID);
  assert.equal(parsedConfig["model"], DEFAULT_CODEX_MODEL_SLUG);
  assert.equal(parsedConfig["model_catalog_json"], DEFAULT_CODEX_CATALOG_FILENAME);
  const providers = parsedConfig["model_providers"] as Record<string, Record<string, unknown>>;
  assert.ok(providers && providers[DEFAULT_CODEX_PROVIDER_ID]);
  assert.equal(providers[DEFAULT_CODEX_PROVIDER_ID]?.["wire_api"], "responses");
  assert.equal(providers[DEFAULT_CODEX_PROVIDER_ID]?.["base_url"], "https://api.openai.com/v1");

  // 验证 control-catalog 可直接读取并追加新模型
  const cwd = join(root, "workspace");
  const rpc: CodexRpcPort = {
    request<T = unknown>(method: string): Promise<T> {
      assert.equal(method, "config/read");
      return Promise.resolve({
        config: { model_catalog_json: first.catalogPath },
        origins: {},
        layers: null,
      } as T);
    },
    async respond() {},
    async respondError() {},
  };
  const readModels = s.codezCatalogReadModelsResultSchema.parse(
    await handleCatalogRequest(
      "catalog/readModels",
      { workspace: { workspacePath: cwd, workspaceKey: cwd } },
      { rpc, cwd },
    ),
  );
  assert.equal(readModels.path, first.catalogPath);
  assert.equal(readModels.models.length, 1);
  assert.equal(readModels.models[0]?.slug, DEFAULT_CODEX_MODEL_SLUG);
  assert.equal(readModels.models[0]?.provider, DEFAULT_CODEX_PROVIDER_ID);

  // 再次调用幂等，不覆盖已有文件
  const second = await ensureDefaultCodexConfigFiles({ CODEX_HOME: codexHome });
  assert.equal(second.createdConfig, false);
  assert.equal(second.createdCatalog, false);
});

test("ensureDefaultCodexConfigFiles preserves existing config.toml and backfills missing referenced catalog file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-existing-codex-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const codexHome = join(root, ".codex");
  await ensureDefaultCodexConfigFiles({ CODEX_HOME: codexHome });
  const customConfig = [
    'model_provider = "my-provider"',
    'model = "my-model"',
    'model_catalog_json = "custom-catalog.json"',
    "[model_providers.my-provider]",
    'name = "My Provider"',
    'base_url = "https://example.com/v1"',
    'wire_api = "chat"',
    "",
  ].join("\n");
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, customConfig, "utf8");

  const result = await ensureDefaultCodexConfigFiles({ CODEX_HOME: codexHome });
  assert.equal(result.createdConfig, false);
  assert.equal(result.createdCatalog, true);
  assert.equal(result.catalogPath, join(codexHome, "custom-catalog.json"));
  assert.equal(await readFile(configPath, "utf8"), customConfig);

  const catalog = JSON.parse(await readFile(result.catalogPath!, "utf8")) as {
    models: Array<{ slug: string; provider: string }>;
  };
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]?.slug, "my-model");
  assert.equal(catalog.models[0]?.provider, "my-provider");
});

test(
  "native codex app-server parses auto-created config.toml and models.json and exposes writable user layer",
  {
    skip: !process.env.CODEX_AUXILIARY_TEST_BINARY,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "codez-native-default-config-"));
    const codexHome = join(root, ".codex");
    const cwd = join(root, "workspace");
    let rpc: ReturnType<typeof createCodexProcess> | undefined;
    t.after(async () => {
      await rpc?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await ensureDefaultCodexConfigFiles({ CODEX_HOME: codexHome });
    rpc = createCodexProcess({
      executable: process.env.CODEX_AUXILIARY_TEST_BINARY!,
      cwd: root,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });
    await rpc.initialize();

    const configRead = s.codexConfigResponseSchema.parse(
      await rpc.request("config/read", { cwd, includeLayers: true }),
    );
    assert.equal(configRead.config["model_provider"], DEFAULT_CODEX_PROVIDER_ID);
    assert.equal(configRead.config["model"], DEFAULT_CODEX_MODEL_SLUG);
    assert.equal(
      await realpath(String(configRead.config["model_catalog_json"])),
      await realpath(join(codexHome, DEFAULT_CODEX_CATALOG_FILENAME)),
    );
    const userLayer = configRead.layers?.find(
      (layer) =>
        layer.name.type === "user" &&
        !layer.name.profile &&
        !layer.disabledReason &&
        layer.name.file,
    );
    assert.ok(userLayer, "expected writable user layer");

    const modelsRead = s.codexModelsResponseSchema.parse(
      await rpc.request("model/list", { includeHidden: false }),
    );
    assert.ok(modelsRead.data.some((entry) => entry.model === DEFAULT_CODEX_MODEL_SLUG));

    // 验证后续可通过 config/batchWrite 添加新供应商，并通过 catalog/writeModel 添加新模型
    const writeProviderResult = s.codexConfigWriteResponseSchema.parse(
      await rpc.request("config/batchWrite", {
        filePath: userLayer.name.file,
        expectedVersion: userLayer.version,
        reloadUserConfig: true,
        edits: [
          {
            keyPath: "model_providers.second-provider",
            value: {
              name: "Second Provider",
              base_url: "https://api.example.com/v1",
              wire_api: "chat",
              requires_openai_auth: false,
            },
            mergeStrategy: "replace",
          },
        ],
      }),
    );
    assert.equal(writeProviderResult.status, "ok");

    const currentCatalog = s.codezCatalogReadModelsResultSchema.parse(
      await handleCatalogRequest(
        "catalog/readModels",
        { workspace: { workspacePath: cwd, workspaceKey: cwd } },
        { rpc, cwd },
      ),
    );
    const template = { ...currentCatalog.models[0], slug: "custom-model-2", provider: "second-provider" };
    const writeModelResult = s.codezCatalogReadResultSchema.parse(
      await handleCatalogRequest(
        "catalog/writeModel",
        { workspace: { workspacePath: cwd, workspaceKey: cwd }, model: template },
        { rpc, cwd },
      ),
    );
    assert.deepEqual(writeModelResult.models, [
      { slug: DEFAULT_CODEX_MODEL_SLUG, provider: DEFAULT_CODEX_PROVIDER_ID },
      { slug: "custom-model-2", provider: "second-provider" },
    ]);
  },
);
