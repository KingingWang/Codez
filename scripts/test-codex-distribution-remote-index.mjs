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

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const env = { GITHUB_RUN_ID: "123", GITHUB_SHA: "a".repeat(40) };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
        files: Object.fromEntries(
          [
            "bin/codex",
            "bin/codex-code-mode-host",
            "codex-package.json",
            "codex-path/rg",
            "bridge.cjs",
            "distribution.json",
          ].map((file) => [`codex/${file}`, sha(file)]),
        ),
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
