import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as s from "@codez/shared";
import { migrateLegacyCatalogVisibility } from "../src/catalog-file.js";
import { createCodexProcess } from "../src/codex-process.js";
import { handleCatalogRequest } from "../src/control-catalog.js";
import {
  createRecommendedCatalogModelEntry,
  ensureDefaultCodexConfigFiles,
} from "../src/default-codex-config.js";

test("startup migration repairs only model visibility, with an original-byte backup and no repeat writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-catalog-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "custom-models.json");
  const original = JSON.stringify({
    metadata: { visibility: "hidden" },
    models: [
      { slug: " old ", visibility: "hidden", capabilities: { visibility: "hidden" } },
      { slug: "visible", visibility: "list" },
      { slug: "hidden", visibility: "hide" },
      { slug: "none", visibility: "none" },
      { slug: "unspecified" },
    ],
  });
  await writeFile(path, original, "utf8");
  await chmod(path, 0o600);
  assert.equal(await migrateLegacyCatalogVisibility(path), true);
  const migrated = await readFile(path, "utf8");
  const file = JSON.parse(migrated);
  const expected = JSON.parse(original);
  expected.models[0].visibility = "hide";
  assert.deepEqual(file, expected);
  const backups = (await readdir(root)).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(root, backups[0]!), "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, backups[0]!))).mode & 0o777, 0o600);
  }
  assert.equal(await migrateLegacyCatalogVisibility(path), false);
  assert.equal(await readFile(path, "utf8"), migrated);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".bak")),
    backups,
  );
});

test("startup migration leaves valid, malformed and unknown-value catalogs untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-catalog-unchanged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, original] of [
    '{"models":[{"slug":"ok","visibility":"hide"}]}',
    "{ not json",
    '{"models":[{"slug":"old","visibility":"hidden"},{"slug":"bad","visibility":"disabled"}]}',
    '{"models":[{"visibility":"hidden"}]}',
    '{"unrelated":{"visibility":"hidden"}}',
  ].entries()) {
    const path = join(root, `${index}.json`);
    await writeFile(path, original, "utf8");
    assert.equal(await migrateLegacyCatalogVisibility(path), false);
    assert.equal(await readFile(path, "utf8"), original);
  }
  assert.equal(await migrateLegacyCatalogVisibility(join(root, "missing.json")), false);
  assert.equal(
    (await readdir(root)).some((name) => name.endsWith(".bak")),
    false,
  );
});

test("startup repair follows absolute/relative configured paths and preserves catalog symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-catalog-configured-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = await ensureDefaultCodexConfigFiles({ CODEX_HOME: root });
  for (const rawPath of ["custom-models.json", join(root, "absolute-models.json")]) {
    const config = `model_catalog_json = ${JSON.stringify(rawPath)}\n`;
    await writeFile(defaults.configPath, config, "utf8");
    const target = rawPath.startsWith(root) ? rawPath : join(root, rawPath);
    await writeFile(target, '{"models":[{"slug":"old","visibility":"hidden"}]}', "utf8");
    const result = await ensureDefaultCodexConfigFiles({ CODEX_HOME: root });
    assert.equal(result.catalogPath, target);
    await migrateLegacyCatalogVisibility(result.catalogPath!);
    assert.equal(JSON.parse(await readFile(target, "utf8")).models[0].visibility, "hide");
    assert.equal(await readFile(defaults.configPath, "utf8"), config);
  }
  if (process.platform !== "win32") {
    const target = join(root, "linked-target.json");
    const link = join(root, "linked-models.json");
    await writeFile(target, '{"models":[{"slug":"old","visibility":"hidden"}]}', "utf8");
    await symlink(target, link);
    await migrateLegacyCatalogVisibility(link);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(JSON.parse(await readFile(target, "utf8")).models[0].visibility, "hide");
  }
});

test(
  "native Codex rejects legacy hidden, then accepts startup repair, reload and restart after catalog writes",
  {
    skip: !process.env.CODEX_AUXILIARY_TEST_BINARY,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "codez-native-catalog-visibility-"));
    let rpc: ReturnType<typeof createCodexProcess> | undefined;
    t.after(async () => {
      await rpc?.close();
      await rm(root, { recursive: true, force: true });
    });
    const defaults = await ensureDefaultCodexConfigFiles({ CODEX_HOME: root });
    const path = defaults.catalogPath!;
    await writeFile(
      path,
      JSON.stringify({
        models: [
          createRecommendedCatalogModelEntry({ slug: "visible" }),
          { ...createRecommendedCatalogModelEntry({ slug: "legacy" }), visibility: "hidden" },
          { ...createRecommendedCatalogModelEntry({ slug: "none" }), visibility: "none" },
        ],
      }),
      "utf8",
    );
    const start = () =>
      createCodexProcess({
        executable: process.env.CODEX_AUXILIARY_TEST_BINARY!,
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          CODEX_HOME: root,
        },
      });
    rpc = start();
    // app-server 握手可能先完成；配置读取才加载目录，不能把 initialize 当作解析证明。
    await rpc.initialize();
    await assert.rejects(
      rpc.request("config/read", { cwd: root, includeLayers: false }),
      /unknown variant.*hidden/,
    );
    await rpc.close();
    assert.equal(await migrateLegacyCatalogVisibility(path), true);
    rpc = start();
    await rpc.initialize();
    const context = { rpc, cwd: root };
    const workspace = { workspace: { workspacePath: root, workspaceKey: root } };
    const list = async (includeHidden: boolean) =>
      s.codexModelsResponseSchema.parse(await rpc!.request("model/list", { includeHidden })).data;
    assert.ok(!(await list(false)).some((model) => model.model === "legacy"));
    assert.ok(!(await list(false)).some((model) => model.model === "none"));
    assert.ok((await list(true)).some((model) => model.model === "legacy" && model.hidden));
    // 旧客户端直连与新 GUI 使用同一写入口，配置重载不能再次触发 unknown variant。
    await handleCatalogRequest(
      "catalog/writeModel",
      {
        ...workspace,
        model: { ...createRecommendedCatalogModelEntry({ slug: "visible" }), visibility: "hidden" },
      },
      context,
    );
    const config = s.codexConfigResponseSchema.parse(
      await rpc.request("config/read", { cwd: root, includeLayers: true }),
    );
    const user = config.layers?.find(
      (layer) => layer.name.type === "user" && !layer.disabledReason,
    );
    assert.ok(user?.name.file);
    await rpc.request("config/batchWrite", {
      filePath: user.name.file,
      expectedVersion: user.version,
      edits: [],
      reloadUserConfig: true,
    });
    await rpc.close();
    rpc = start();
    await rpc.initialize();
    assert.ok(!(await list(false)).some((model) => model.model === "visible"));
    assert.ok((await list(true)).some((model) => model.model === "visible" && model.hidden));
  },
);
