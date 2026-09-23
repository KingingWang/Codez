import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { prepareDesktopRemoteAssets } from "../packages/desktop/scripts/prepare-remote-assets.mjs";
import { buildDesktopRemoteProdEnv } from "./dev-desktop-remote-prod.mjs";
import {
  loadCodexManifest,
  snapshotCodexBridge,
  stageCodexRuntime,
  publishCodexBuildSelection,
  resolveCodexBuildSelection,
} from "./codex-runtime.mjs";

test("public remote preparation defaults to Codex and requires explicit legacy opt-in", async () => {
  const calls = [];
  const options = {
    prepareCodex: async () => calls.push("codex"),
    runLegacy: async () => calls.push("legacy"),
  };
  await prepareDesktopRemoteAssets({ ...options, env: {} });
  await prepareDesktopRemoteAssets({ ...options, env: { CODEZ_DESKTOP_RUNTIME: "legacy" } });
  assert.deepEqual(calls, ["codex", "legacy"]);
  const desktop = JSON.parse(
    await readFile(new URL("../packages/desktop/package.json", import.meta.url), "utf8"),
  );
  assert.equal(desktop.scripts["prepare:remote-assets"], "node scripts/prepare-remote-assets.mjs");
});

test("standard Electron dev entry has valid workspace SemVer without replacing updater", async () => {
  const packageUrl = new URL("../packages/desktop/package.json", import.meta.url);
  const require = createRequire(packageUrl);
  const desktop = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(desktop.private, true);
  // Electron 的默认 0.0 不能通过 updater 构造阶段的 semver 校验，禁用更新分支来不及拦截。
  assert.equal(require("semver").valid(desktop.version), desktop.version);
  assert.equal(desktop.version, "0.0.0");
  const builder = await readFile(
    new URL("../packages/desktop/electron-builder.config.js", import.meta.url),
    "utf8",
  );
  assert.match(builder, /extraMetadata:\s*\{\s*version: buildMetadata\.appVersion/);
});

test("remote-prod uses fork cache on every OS and refuses upstream CDN selection", () => {
  for (const [platform, home] of [
    ["linux", "/home/test"],
    ["darwin", "/Users/test"],
    ["win32", "C:\\Users\\test"],
  ]) {
    const codex = buildDesktopRemoteProdEnv({}, platform, home);
    const legacy = buildDesktopRemoteProdEnv({ CODEZ_DESKTOP_RUNTIME: "legacy" }, platform, home);
    assert.match(codex.CODEZ_REMOTE_ASSET_CACHE_DIR, /Codez/);
    // 更名后 codex 与 legacy 共享 Codez 显示目录（不再断言路径不同）；
    // 隔离由 appId、协议 scheme 与 ~/.codez-codex 数据目录保证。
    assert.equal(codex.CODEZ_REMOTE_ASSET_CACHE_DIR, legacy.CODEZ_REMOTE_ASSET_CACHE_DIR);
    assert.equal(codex.CODEZ_DEV_REMOTE_ASSET_USE_CDN, "0");
    assert.equal(legacy.CODEZ_DEV_REMOTE_ASSET_USE_CDN, "1");
    assert.equal(codex.CODEZ_DESKTOP_RUNTIME, "codex");
  }
  assert.throws(
    () => buildDesktopRemoteProdEnv({ CODEZ_DEV_REMOTE_ASSET_USE_CDN: "1" }),
    /legacy CDN/,
  );
  assert.throws(
    () =>
      buildDesktopRemoteProdEnv({ CODEZ_REMOTE_ASSET_CDN_BASE_URL: "https://upstream.invalid" }),
    /legacy CDN/,
  );
  assert.equal(
    buildDesktopRemoteProdEnv({ CODEZ_REMOTE_ASSET_CACHE_DIR: "/custom-cache" })
      .CODEZ_REMOTE_ASSET_CACHE_DIR,
    "/custom-cache",
    "Main adds the Codex namespace exactly once",
  );
});

test("distribution snapshots and build selection survive concurrent workspace bridge rebuilds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-build-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridgePath = join(root, "bridge.cjs");
  await writeFile(bridgePath, "first bridge");
  const snapshot = await snapshotCodexBridge({ bridgePath, root });
  await writeFile(bridgePath, "concurrent second bridge");
  assert.equal(await readFile(snapshot, "utf8"), "first bridge");
  const bytes = Buffer.from("native fixture");
  const manifest = await loadCodexManifest();
  manifest.assets["linux-x64"].size = bytes.length;
  manifest.assets["linux-x64"].sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = { os: "linux", arch: "x64", key: "linux-x64" };
  const options = { root, manifest, target };
  const directory = await stageCodexRuntime({
    ...options,
    bridgePath: snapshot,
    env: {},
    fetchImpl: async () => new Response(bytes),
  });
  await publishCodexBuildSelection({ ...options, directory });
  const selected = await resolveCodexBuildSelection(options);
  assert.equal(selected.directory, directory);
  assert.equal(await readFile(join(selected.directory, "bridge.cjs"), "utf8"), "first bridge");
  const selectionPath = join(root, target.key, "selection.json");
  const selection = JSON.parse(await readFile(selectionPath, "utf8"));
  selection.bridgeSha256 = "../escape";
  await writeFile(selectionPath, JSON.stringify(selection));
  await assert.rejects(resolveCodexBuildSelection(options), /Invalid Codex build selection/);
});
