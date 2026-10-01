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
    draft: false,
    prerelease: false,
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
  assert.throws(
    () => buildManifestFromLatestRelease(fakeRelease({ assets: null })),
    /malformed asset list/,
  );
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

test("incomplete latest uses one older complete stable release without mixing native targets", async () => {
  const latest = fakeRelease({
    tag_name: "codex-20260930-142651",
    assets: fakeRelease().assets.filter((asset) => asset.name !== "codex-windows-x86_64.exe"),
  });
  const prior = fakeRelease();
  const urls = [];
  const manifest = await resolveLatestCodexManifest({
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => (url.endsWith("/latest") ? latest : [latest, prior]) };
    },
    attempts: 1,
  });
  assert.deepEqual(
    urls.map((url) => new URL(url).pathname.split("/").at(-1)),
    ["latest", "releases"],
  );
  assert.match(urls[1], /per_page=10$/);
  assert.equal(manifest.tag, prior.tag_name);
  assert.deepEqual(manifest.assets, buildManifestFromLatestRelease(prior).assets);
});

test("latest wins if it finishes uploading before the bounded release list is read", async () => {
  const latest = fakeRelease({ tag_name: "codex-20260930-142651" });
  const incomplete = {
    ...latest,
    assets: latest.assets.filter((asset) => asset.name !== "codex-windows-aarch64.exe"),
  };
  const manifest = await resolveLatestCodexManifest({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => (url.endsWith("/latest") ? incomplete : [latest, fakeRelease()]),
    }),
    attempts: 1,
  });
  assert.equal(manifest.tag, latest.tag_name);
});

test("fallback rejects drafts, prereleases, all-incomplete lists and missing latest", async () => {
  const latest = fakeRelease({
    tag_name: "codex-20260930-142651",
    assets: fakeRelease().assets.slice(1),
  });
  const fetchFromList = (releases) => async (url) => ({
    ok: true,
    json: async () => (url.endsWith("/latest") ? latest : releases),
  });
  for (const releases of [
    [latest, fakeRelease({ draft: true }), fakeRelease({ prerelease: true })],
    [latest],
    [fakeRelease()],
  ]) {
    await assert.rejects(
      resolveLatestCodexManifest({ fetchImpl: fetchFromList(releases), attempts: 1 }),
    );
  }
});

test("fallback skips complete drafts and prereleases in favor of an older stable release", async () => {
  const latest = fakeRelease({
    tag_name: "codex-20260930-142651",
    assets: fakeRelease().assets.slice(1),
  });
  const stable = fakeRelease({ tag_name: "codex-20260928-074010" });
  const manifest = await resolveLatestCodexManifest({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/latest")
          ? latest
          : [
              latest,
              fakeRelease({ tag_name: "codex-20260929-185524", draft: true }),
              fakeRelease({ tag_name: "codex-20260929-091308", prerelease: true }),
              stable,
            ],
    }),
    attempts: 1,
  });
  assert.equal(manifest.tag, stable.tag_name);
});

test("fallback never searches beyond the ten most recent releases", async () => {
  const latest = fakeRelease({
    tag_name: "codex-20260930-142651",
    assets: fakeRelease().assets.slice(1),
  });
  await assert.rejects(
    resolveLatestCodexManifest({
      fetchImpl: async (url) => ({
        ok: true,
        json: async () =>
          url.endsWith("/latest")
            ? latest
            : [latest, ...Array.from({ length: 9 }, () => latest), fakeRelease()],
      }),
      attempts: 1,
    }),
    /No complete verified/,
  );
});

test("a malformed latest digest fails closed without silently selecting an older release", async () => {
  const latest = fakeRelease();
  latest.assets[0].digest = null;
  let calls = 0;
  await assert.rejects(
    resolveLatestCodexManifest({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => (calls === 1 ? latest : [latest, fakeRelease()]) };
      },
      attempts: 1,
    }),
    /verified asset/,
  );
  assert.equal(calls, 1);
});

test("release list API failure cannot publish a stale manifest", async () => {
  const latest = fakeRelease({ assets: fakeRelease().assets.slice(1) });
  await assert.rejects(
    resolveLatestCodexManifest({
      fetchImpl: async (url) =>
        url.endsWith("/latest")
          ? { ok: true, json: async () => latest }
          : { ok: false, status: 503 },
      attempts: 1,
    }),
    /release list lookup failed: HTTP 503/,
  );
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
