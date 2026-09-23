import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCodexManifest, selectCodexAsset, resolveCodexTarget } from "./codex-runtime.mjs";
import {
  buildManifestFromLatestRelease,
  resolveLatestCodexManifest,
} from "./codex-runtime-resolve-latest.mjs";

const TARGET_ASSET_NAMES = {
  "darwin-x64": "codex-macos-x86_64",
  "darwin-arm64": "codex-macos-aarch64",
  "linux-x64": "codex-linux-x86_64-musl",
  "linux-arm64": "codex-linux-aarch64-musl",
  "win32-x64": "codex-windows-x86_64.exe",
  "win32-arm64": "codex-windows-aarch64.exe",
};

function fakeRelease(overrides = {}) {
  return {
    tag_name: "codex-20260922-232812",
    assets: Object.values(TARGET_ASSET_NAMES).map((name, index) => ({
      name,
      size: 100_000_000 + index,
      digest: `sha256:${String(index).padStart(2, "0")}${"a".repeat(62)}`,
    })),
    ...overrides,
  };
}

test("latest fork release resolves into a valid six-target manifest", () => {
  const manifest = buildManifestFromLatestRelease(fakeRelease());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, "KingingWang/codex");
  assert.equal(manifest.tag, "codex-20260922-232812");
  assert.equal(Object.keys(manifest.assets).length, 6);
  for (const os of ["darwin", "linux", "win32"])
    for (const arch of ["x64", "arm64"]) {
      const asset = selectCodexAsset(
        manifest,
        resolveCodexTarget({ CODEZ_TARGET_OS: os, CODEZ_TARGET_ARCH: arch }),
      );
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.ok(asset.url.includes("/releases/download/codex-20260922-232812/"));
    }
});

test("incomplete or malformed latest releases fail closed", () => {
  assert.throws(() => buildManifestFromLatestRelease({ tag_name: "v1.0.0", assets: [] }));
  const missing = fakeRelease();
  missing.assets = missing.assets.slice(1);
  assert.throws(() => buildManifestFromLatestRelease(missing), /verified asset/);
  const noDigest = fakeRelease();
  noDigest.assets[0].digest = null;
  assert.throws(() => buildManifestFromLatestRelease(noDigest), /verified asset/);
  const zeroSize = fakeRelease();
  zeroSize.assets[2].size = 0;
  assert.throws(() => buildManifestFromLatestRelease(zeroSize), /verified asset/);
});

test("lookup retries transient failures then returns the manifest", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 500 };
    return { ok: true, json: async () => fakeRelease() };
  };
  const manifest = await resolveLatestCodexManifest({
    fetchImpl,
    retryDelay: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(manifest.tag, "codex-20260922-232812");
  const alwaysDown = await resolveLatestCodexManifest({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    attempts: 2,
    retryDelay: async () => {},
  }).then(
    () => null,
    (error) => error,
  );
  assert.match(String(alwaysDown), /HTTP 503/);
});

test("CODEZ_CODEX_MANIFEST overrides the checked-in fallback manifest", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-manifest-override-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resolved = buildManifestFromLatestRelease(fakeRelease());
  const path = join(dir, "resolved.json");
  await writeFile(path, JSON.stringify(resolved));
  const loaded = await loadCodexManifest({ CODEZ_CODEX_MANIFEST: path });
  assert.equal(loaded.tag, "codex-20260922-232812");
  const fallback = await loadCodexManifest({});
  assert.match(fallback.tag, /^codex-\d{8}-\d{6}$/);
  assert.equal(fallback.repository, "KingingWang/codex");
});
