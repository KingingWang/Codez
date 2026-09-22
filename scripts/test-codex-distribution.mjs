import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCodexManifest,
  resolveCodexTarget,
  selectCodexAsset,
  stageCodexRuntime,
  verifyCodexResources,
} from "./codex-runtime.mjs";
import { generateCodexSchema } from "./codex-runtime-schema.mjs";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { writeCodexArtifactChecksums } from "./codex-runtime-artifacts.mjs";
import { prepareCodexRemoteComponent } from "./codex-runtime-remote.mjs";
import {
  resolveDesktopProductIdentity,
  resolveDesktopRuntime,
} from "../packages/desktop/scripts/desktop-product-identity.mjs";
import { createDesktopProductionBuildPlan } from "../packages/desktop/scripts/run-production-build.mjs";
import {
  loadCodexNodeManifest,
  selectCodexNodeAsset,
  stageCodexRemoteNode,
} from "./codex-runtime-node.mjs";
import { prepareCodexRemotePackage } from "./codex-runtime-remote-package.mjs";
import { runCodexTar } from "./codex-runtime-archive.mjs";

const bytes = Buffer.from("mock native executable\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex distribution & spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridgePath = join(root, "bridge.cjs");
  await writeFile(bridgePath, "// mock bridge\n");
  const manifest = structuredClone(await loadCodexManifest());
  manifest.assets["linux-x64"].sha256 = sha256;
  manifest.assets["linux-x64"].size = bytes.length;
  return {
    root,
    bridgePath,
    manifest,
    target: resolveCodexTarget({ ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "x64" }),
    fetchImpl: async () => new Response(bytes),
    env: {},
  };
}

test("manifest pins exactly six native binaries with release digests", async () => {
  const manifest = await loadCodexManifest();
  assert.equal(manifest.repository, "KingingWang/codex");
  assert.equal(manifest.tag, "codex-20260921-084453");
  assert.equal(Object.keys(manifest.assets).length, 6);
  for (const os of ["darwin", "linux", "win32"]) {
    for (const arch of ["x64", "arm64"]) {
      const target = resolveCodexTarget({ ZCODE_TARGET_OS: os, ZCODE_TARGET_ARCH: arch });
      const asset = selectCodexAsset(manifest, target);
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.ok(asset.size > 1_000_000);
      assert.equal(asset.binaryName, os === "win32" ? "codex.exe" : "codex");
      assert.equal(new URL(asset.url).hostname, "github.com");
      assert.ok(asset.url.endsWith(`/${asset.name}`));
    }
  }
});

test("target aliases normalize; shell and traversal input fail closed", () => {
  assert.equal(
    resolveCodexTarget({ ZCODE_TARGET_OS: "Windows", ZCODE_TARGET_ARCH: "aarch64" }).key,
    "win32-arm64",
  );
  assert.equal(
    resolveCodexTarget({ ZCODE_TARGET_OS: "macos", ZCODE_TARGET_ARCH: "amd64" }).key,
    "darwin-x64",
  );
  for (const value of ["../linux", "linux; touch sentinel", "$(whoami)", "", "ia32"]) {
    assert.throws(() => resolveCodexTarget({ ZCODE_TARGET_OS: value }));
    assert.throws(() => resolveCodexTarget({ ZCODE_TARGET_ARCH: value }));
  }
});

test("downloads only selected asset, stages complete resources, and verifies cache", async (t) => {
  const options = await fixture(t);
  const urls = [];
  options.fetchImpl = async (url) => {
    urls.push(url);
    return new Response(bytes);
  };
  const directory = await stageCodexRuntime(options);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith("codex-linux-x86_64-musl"));
  assert.equal(await readFile(join(directory, "codex"), "utf8"), bytes.toString());
  await verifyCodexResources({ directory, target: options.target, manifest: options.manifest });
  assert.equal(await stageCodexRuntime(options), directory);
  assert.equal(urls.length, 1);
  await writeFile(join(directory, "codex"), "corruption");
  await assert.rejects(
    verifyCodexResources({ directory, target: options.target, manifest: options.manifest }),
    /checksum|size/,
  );
});

test("checksum, HTTP, size and stream failures never publish partial resources", async (t) => {
  for (const fetchImpl of [
    async () => new Response(Buffer.alloc(bytes.length, 0)),
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("short"),
    async () => new Response(Buffer.alloc(bytes.length + 1)),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("disconnected"));
          },
        }),
      ),
  ]) {
    const options = await fixture(t);
    await assert.rejects(stageCodexRuntime({ ...options, fetchImpl }));
    assert.deepEqual(await readdir(join(options.root, "linux-x64")), []);
  }
});

test("all six targets stage only their native executable filename", async (t) => {
  const options = await fixture(t);
  for (const key of Object.keys(options.manifest.assets)) {
    const [os, arch] = key.split("-");
    const target = resolveCodexTarget({ ZCODE_TARGET_OS: os, ZCODE_TARGET_ARCH: arch });
    options.manifest.assets[key].sha256 = sha256;
    options.manifest.assets[key].size = bytes.length;
    const directory = await stageCodexRuntime({ ...options, target });
    assert.deepEqual((await readdir(directory)).sort(), [
      "bridge.cjs",
      os === "win32" ? "codex.exe" : "codex",
      "distribution.json",
    ]);
    await verifyCodexResources({ directory, target, manifest: options.manifest });
  }
});

test("concurrent publishers converge without replacing a complete version", async (t) => {
  const options = await fixture(t);
  const [first, second] = await Promise.all([
    stageCodexRuntime(options),
    stageCodexRuntime(options),
  ]);
  assert.equal(first, second);
  await verifyCodexResources({
    directory: first,
    target: options.target,
    manifest: options.manifest,
  });
  assert.ok(
    (await readdir(join(options.root, "linux-x64"))).every((name) => !name.startsWith(".")),
  );
});

test("real HTTP stream from loopback produces the pinned local fixture", async (t) => {
  const options = await fixture(t);
  const server = createServer((_request, response) => response.end(bytes));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  const directory = await stageCodexRuntime({
    ...options,
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/fixture`, init),
  });
  await verifyCodexResources({ directory, target: options.target, manifest: options.manifest });
});

test("bridge changes during download cannot publish a mixed version", async (t) => {
  const options = await fixture(t);
  options.fetchImpl = async () => {
    await writeFile(options.bridgePath, "changed while downloading");
    return new Response(bytes);
  };
  await assert.rejects(stageCodexRuntime(options), /bridge checksum/);
  const entries = await readdir(join(options.root, "linux-x64"));
  assert.deepEqual(entries, [`codex-${sha256}`]);
});

test("schema output rejects outside paths and symlink escapes before executing", async (t) => {
  await assert.rejects(generateCodexSchema("../codex/generated"), /inside ZCode/);
  const options = await fixture(t);
  const localParent = new URL("../.zcode-runtime/", import.meta.url);
  await mkdir(localParent, { recursive: true });
  const local = await mkdtemp(new URL("schema-path-test-", localParent));
  t.after(() => rm(local, { recursive: true, force: true }));
  await symlink(
    options.root,
    join(local, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(generateCodexSchema(join(local, "escape", "schema")), /symlink/);
});

test("failed refresh preserves previous resource pair", async (t) => {
  const options = await fixture(t);
  const directory = await stageCodexRuntime(options);
  await writeFile(options.bridgePath, "// new bridge\n");
  options.manifest.assets["linux-x64"].sha256 = "0".repeat(64);
  await assert.rejects(stageCodexRuntime(options), /checksum/);
  assert.equal(await readFile(join(directory, "bridge.cjs"), "utf8"), "// mock bridge\n");
  assert.equal(await readFile(join(directory, "codex"), "utf8"), bytes.toString());
});

test("unsafe manifest names, missing digests and local overrides are rejected", async (t) => {
  const options = await fixture(t);
  for (const name of ["../codex", "codex/evil", "codex\\evil", "codex;evil"]) {
    const manifest = structuredClone(options.manifest);
    manifest.assets["linux-x64"].name = name;
    assert.throws(() => selectCodexAsset(manifest, options.target));
  }
  const manifest = structuredClone(options.manifest);
  delete manifest.assets["linux-x64"].sha256;
  assert.throws(() => selectCodexAsset(manifest, options.target));
  await assert.rejects(
    stageCodexRuntime({ ...options, env: { CI: "true", ZCODE_CODEX_BINARY: "/tmp/untrusted" } }),
    /override/,
  );
});

test("Codex product identity never collides with upstream", () => {
  const codex = resolveDesktopProductIdentity({
    ZCODE_DESKTOP_RUNTIME: "codex",
    ZCODE_ENV: "production",
  });
  const upstream = resolveDesktopProductIdentity({
    ZCODE_ENV: "production",
    ZCODE_DESKTOP_RUNTIME: "legacy",
  });
  assert.equal(codex.productName, "ZCode Codex");
  for (const field of ["appId", "linuxExecutableName", "linuxPackageName"])
    assert.notEqual(codex[field], upstream[field]);
});

test("bare desktop entrypoints default to Codex and only explicit legacy retains upstream", () => {
  assert.equal(resolveDesktopRuntime({}), "codex");
  assert.equal(resolveDesktopProductIdentity({}).flavor, "codex");
  assert.equal(resolveDesktopProductIdentity({ ZCODE_ENV: "production" }).flavor, "codex");
  assert.equal(
    resolveDesktopProductIdentity({ ZCODE_DESKTOP_RUNTIME: "legacy", ZCODE_ENV: "production" })
      .flavor,
    "production",
  );
  assert.throws(
    () => resolveDesktopRuntime({ ZCODE_DESKTOP_RUNTIME: "typo" }),
    /expected codex or legacy/,
  );
  const [step] = createDesktopProductionBuildPlan({ cwd: "/fixture", baseEnv: {} });
  for (const build of step.parallel) assert.equal(build.env.ZCODE_DESKTOP_RUNTIME, "codex");
});

test("remote Node pins cover four targets; corrupted downloads preserve the previous binary", async (t) => {
  const options = await fixture(t);
  const manifest = await loadCodexNodeManifest();
  for (const [key, digest] of Object.entries(manifest.assets)) {
    const [os, arch] = key.split("-");
    assert.equal(selectCodexNodeAsset(manifest, { os, arch, key }).sha256, digest);
  }
  assert.throws(() => selectCodexNodeAsset(manifest, { key: "linux-x64;bad" }), /target/);
  await writeFile(join(options.root, "node"), "previous valid binary");
  await assert.rejects(
    stageCodexRemoteNode({
      directory: options.root,
      target: options.target,
      fetchImpl: options.fetchImpl,
    }),
    /checksum/,
  );
  assert.equal(await readFile(join(options.root, "node"), "utf8"), "previous valid binary");
  assert.deepEqual(
    (await readdir(options.root)).filter((name) => name.startsWith(".node-")),
    [],
  );
});

test("remote assembly publishes existing manifest schema, genuine Codex mounts and checked archives", async (t) => {
  const options = await fixture(t);
  const outputRoot = join(options.root, "remote");
  const manifest = await prepareCodexRemotePackage({
    target: options.target,
    stagingOptions: options,
    outputRoot,
    publishComponents: true,
    prepareServerImpl: async (dir) => {
      for (const name of ["zcode-server.cjs", "THIRD-PARTY-NOTICES.md"])
        await writeFile(join(dir, name), "fixture");
    },
    prepareNodeImpl: async ({ directory }) => {
      for (const name of ["node", "LICENSE.node.txt", "NODE-SOURCES.json"])
        await writeFile(join(directory, name), "fixture");
      return { version: "24.14.0" };
    },
    preparePtyImpl: async (dir, target) => {
      const path = join(dir, "prebuilds", target.key);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "pty.node"), "fixture");
    },
    prepareSearchImpl: async ({ outputDir }) => {
      for (const id of ["bfs", "ripgrep", "ugrep"]) {
        await mkdir(join(outputDir, id), { recursive: true });
        await writeFile(join(outputDir, id, id), "fixture");
      }
    },
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.components.length, 7);
  assert.equal(manifest.components.find(({ id }) => id === "codex-runtime").mount, "codex");
  assert.ok(!manifest.components.some(({ id }) => id === "glm"));
  for (const component of manifest.components) {
    assert.match(component.artifactPath, /^components\/linux-x64\//);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(outputRoot, component.artifactPath)))
        .digest("hex"),
      component.sha256,
    );
  }
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(outputRoot, "releases", manifest.appVersion, "manifest-linux-x64.json"),
        "utf8",
      ),
    ),
    manifest,
  );
});

test("bridge bundles as executable CJS; failed build preserves prior output", async (t) => {
  const { root } = await fixture(t);
  const source = join(root, "packages/codex-bridge/src");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "main.ts"),
    'import { value } from "./value"; process.stdout.write(value);',
  );
  await writeFile(join(source, "value.ts"), 'export const value: string = "self-contained-cjs";');
  const output = await buildCodexBridge({ workspaceRoot: root });
  assert.equal(output, join(root, "packages/codex-bridge/dist/bridge.cjs"));
  const result = await promisify(execFile)(process.execPath, [output]);
  assert.equal(result.stdout, "self-contained-cjs");
  const previous = await readFile(output);
  await writeFile(join(source, "main.ts"), "this is invalid typescript!!!");
  await assert.rejects(buildCodexBridge({ workspaceRoot: root }));
  assert.deepEqual(await readFile(output), previous);
  assert.deepEqual(await readdir(join(root, "packages/codex-bridge/dist")), ["bridge.cjs"]);
});

test("artifact checksums require each native installer and exclude unrelated files", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(writeCodexArtifactChecksums(root), /Missing .* installer/);
  const target = resolveCodexTarget();
  const platform = { darwin: "mac", win32: "win", linux: "linux" }[target.os];
  const extensions = { darwin: ["dmg", "zip"], win32: ["exe"], linux: ["AppImage", "deb"] }[
    target.os
  ];
  const suffix = process.env.ZCODE_CODEX_SIGNED === "1" ? "" : "-unsigned";
  const files = extensions.map((ext) => {
    const arch = target.key === "linux-x64" ? (ext === "deb" ? "amd64" : "x86_64") : target.arch;
    return `ZCode Codex-1.0.0-${platform}-${arch}${suffix}.${ext}`;
  });
  for (const name of files) await writeFile(join(root, name), bytes);
  await writeFile(join(root, "unrelated.exe"), "do not publish");
  const manifest = await readFile(await writeCodexArtifactChecksums(root), "utf8");
  assert.equal(
    manifest,
    files
      .sort()
      .map((file) => `${sha256}  ${file}\n`)
      .join(""),
  );
});

test("remote producer archives Codex resources and separates consumer integration from transport validation", async (t) => {
  const options = await fixture(t);
  const outputRoot = join(options.root, "remote");
  const descriptor = await prepareCodexRemoteComponent({ ...options, outputRoot });
  assert.equal(descriptor.componentId, "codex-runtime");
  assert.equal(descriptor.deploymentContract, "codex-components-v1");
  assert.equal(Object.hasOwn(descriptor, "deploymentReady"), false);
  assert.equal(Object.hasOwn(descriptor, "missingConsumers"), false);
  assert.deepEqual(descriptor.transportValidation, { ssh: "not-run", wsl: "not-run" });
  assert.equal(descriptor.nodeVersion, "24.14.0");
  assert.equal(descriptor.runtimeRoot, "~/.zcode-codex/server");
  assert.match(descriptor.requiredEnv.ZCODE_CODEX_BRIDGE_PATH, /\/codex\/bridge.cjs$/);
  const { stdout } = await runCodexTar({
    mode: "list",
    archivePath: join(outputRoot, descriptor.artifactPath),
  });
  assert.deepEqual(stdout.trim().split(/\r?\n/).sort(), [
    "bridge.cjs",
    "codex",
    "distribution.json",
  ]);
  const archive = await readFile(join(outputRoot, descriptor.artifactPath));
  assert.equal(createHash("sha256").update(archive).digest("hex"), descriptor.sha256);
  await assert.rejects(
    prepareCodexRemoteComponent({
      ...options,
      target: resolveCodexTarget({ ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "arm64" }),
      outputRoot,
    }),
    /Remote Codex targets/,
  );
});
