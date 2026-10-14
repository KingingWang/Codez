import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCodexRemoteIndex,
  remoteComponentAssetName,
  verifyCodexRemoteIndex,
} from "./codex-runtime-remote-index.mjs";
import { ensureCodexRemoteAssets } from "./codex-runtime-remote-assets.mjs";
import { loadCodexManifest } from "./codex-runtime.mjs";
import { loadCodexNodeManifest } from "./codex-runtime-node.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const env = { GITHUB_RUN_ID: "123", GITHUB_SHA: "a".repeat(40) };
const bridgeBytes = "// producer bridge\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await loadCodexManifest();
  const node = await loadCodexNodeManifest();
  await writeFile(join(root, "bridge.cjs"), bridgeBytes);
  for (const target of targets) {
    const mounts = {
      "server-bundle": "server",
      "node-runtime": `node/${target}`,
      "node-pty": `node-pty/${target}`,
      "codex-native": "codex",
      "codex-bridge": "codex-bridge",
      ...(target.startsWith("darwin-")
        ? { ripgrep: `tools/${target}/ripgrep` }
        : Object.fromEntries(
            ["bfs", "ripgrep", "ugrep"].map((id) => [id, `tools/${target}/${id}`]),
          )),
    };
    const components = [];
    for (const [id, mount] of Object.entries(mounts)) {
      const bytes = Buffer.from(`${id} ${target}`);
      const digest = sha(bytes);
      const artifactPath = `components/${target}/${id}/${digest}.tar.gz`;
      await mkdir(join(root, "components", target, id), { recursive: true });
      await writeFile(join(root, artifactPath), bytes);
      components.push({ id, version: "test", sha256: digest, artifactPath, mount });
    }
    const manifest = {
      schemaVersion: 1,
      appVersion: "3.15.1",
      platformArch: target,
      components,
    };
    await mkdir(join(root, "releases", "3.15.1"), { recursive: true });
    await writeFile(
      join(root, "releases", "3.15.1", `manifest-${target}.json`),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(root, "releases", "3.15.1", `runtime-${target}.json`),
      JSON.stringify({
        deploymentContract: "codex-components-v1",
        codexPackageSha256: native.assets[target].sha256,
        node: { archiveSha256: node.assets[target] },
        files: {
          ...Object.fromEntries(
            [
              "bin/codex",
              "bin/codex-code-mode-host",
              "codex-package.json",
              "codex-path/rg",
              "distribution.json",
            ].map((file) => [`codex/${file}`, sha(file)]),
          ),
          "codex/bridge.cjs": sha(bridgeBytes),
          "codez-server.cjs": sha("Linux producer server, not the desktop host's bundle"),
        },
      }),
    );
  }
  return root;
}

test("build-pinned index has four manifests and deterministic flat GitHub asset names", async (t) => {
  const root = await fixture(t);
  await createCodexRemoteIndex({ root, version: "3.15.1", env });
  const verified = await verifyCodexRemoteIndex({ root, version: "3.15.1", env });
  assert.equal(verified.index.releaseTag, `codez-build-123-${"a".repeat(12)}`);
  assert.equal(Object.keys(verified.index.manifests).length, 4);
  assert.equal(verified.packagedFiles.length, 5);
  assert.equal(verified.releaseAssets.length, 32);
  assert.ok(verified.packagedFiles.every((path) => !path.startsWith("components/")));
  assert.equal(
    remoteComponentAssetName("linux-x64", "codex-native", "a".repeat(64)),
    `codex-remote-linux-x64-codex-native-${"a".repeat(64)}.tar.gz`,
  );
});

test("local sidecar tag changes when a manifest changes at the same app version", async (t) => {
  const root = await fixture(t);
  const localEnv = {};
  const first = await createCodexRemoteIndex({ root, version: "3.15.1", env: localEnv });
  assert.match(first.releaseTag, /^codez-local-3\.15\.1-[a-f0-9]{12}$/);
  const path = join(root, "releases", "3.15.1", "manifest-linux-x64.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.components[0].version = "test-2";
  await writeFile(path, JSON.stringify(manifest));
  const second = await createCodexRemoteIndex({ root, version: "3.15.1", env: localEnv });
  assert.notEqual(second.releaseTag, first.releaseTag);
  await verifyCodexRemoteIndex({ root, version: "3.15.1", env: localEnv });
});

test("tampered sidecar, manifest or build identity is rejected before use", async (t) => {
  const root = await fixture(t);
  await createCodexRemoteIndex({ root, version: "3.15.1", env });
  await assert.rejects(
    verifyCodexRemoteIndex({ root, version: "3.15.1", env: { ...env, GITHUB_RUN_ID: "124" } }),
    /release tag/i,
  );
  const path = join(root, "releases", "3.15.1", "manifest-linux-x64.json");
  const original = await readFile(path);
  await writeFile(path, "{}");
  await assert.rejects(verifyCodexRemoteIndex({ root, version: "3.15.1", env }), /manifest.*sha/i);
  await writeFile(path, original);
  const manifest = JSON.parse(original.toString());
  await writeFile(join(root, manifest.components[0].artifactPath), "corrupt");
  await assert.rejects(verifyCodexRemoteIndex({ root, version: "3.15.1", env }), /component.*sha/i);
});

test("read-only desktop consumers preserve producer bytes without rebuilding the remote server", async (t) => {
  const root = await fixture(t);
  await createCodexRemoteIndex({ root, version: "3.15.1", env });
  const { packagedFiles, releaseAssets } = await verifyCodexRemoteIndex({
    root,
    version: "3.15.1",
    env,
  });
  const paths = [
    ...packagedFiles.map((path) => join(root, path)),
    ...releaseAssets.map(({ path }) => path),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  await ensureCodexRemoteAssets({
    root,
    bridgePath: join(root, "bridge.cjs"),
    env: { ...process.env, ...env, CODEZ_CODEX_REMOTE_ASSETS_READONLY: "1" },
  });
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
});

test("read-only consumers reject missing, corrupt or stale inputs instead of refreshing them", async (t) => {
  for (const fault of ["missing-index", "corrupt-archive", "stale-bridge"]) {
    const root = await fixture(t);
    const index = await createCodexRemoteIndex({ root, version: "3.15.1", env });
    if (fault === "missing-index") await rm(join(root, "index.json"));
    if (fault === "corrupt-archive")
      await writeFile(join(root, Object.keys(index.assets)[0]), "corrupt");
    if (fault === "stale-bridge") await writeFile(join(root, "bridge.cjs"), "// different bridge");
    const manifestPath = join(root, "releases", "3.15.1", "manifest-linux-x64.json");
    const before = await readFile(manifestPath);
    await assert.rejects(
      ensureCodexRemoteAssets({
        root,
        bridgePath: join(root, "bridge.cjs"),
        env: { ...process.env, ...env, CODEZ_CODEX_REMOTE_ASSETS_READONLY: "1" },
      }),
      fault === "missing-index" ? /ENOENT/ : /checksum|Stale remote runtime/,
      fault,
    );
    assert.deepEqual(await readFile(manifestPath), before);
  }
});
