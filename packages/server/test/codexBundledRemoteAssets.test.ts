import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { remoteAssetDirsSchema, CODEZ_VERSION } from "@codez/shared";
import { createTarGzArchive } from "../src/remote/localTarGz.js";
import { resolvePosixHomePath } from "../src/remote/posixShell.js";
import type { IRemoteBackend } from "../src/remote/backend.js";

process.env.CODEZ_DESKTOP_RUNTIME = "codex";
const { createBundledRemoteAssetSource } = await import("../src/remote/bundledRemoteAssets.js");
const { computeFileSha256 } = await import("../src/remote/remoteAssetCache.js");
const { deployServer } = await import("../src/remote/deploy.js");

const version = "1.0.0";
const loggers = { log() {}, logWarn() {} };

async function fixture(root: string, target: string, contents = target) {
  const source = join(root, `fixture-${target}`);
  await mkdir(source, { recursive: true });
  for (const name of ["codex", "bridge.cjs", "distribution.json"])
    await writeFile(join(source, name), contents);
  const archive = join(source, "fixture.tar.gz");
  await createTarGzArchive(
    archive,
    ["codex", "bridge.cjs", "distribution.json"].map((name) => ({
      sourcePath: join(source, name),
      archivePath: name,
    })),
  );
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactPath = `components/${target}/codex-runtime/${sha256}.tar.gz`;
  await mkdir(dirname(join(root, artifactPath)), { recursive: true });
  await writeFile(join(root, artifactPath), bytes);
  const manifest = {
    schemaVersion: 1,
    appVersion: version,
    platformArch: target,
    components: [{ id: "codex-runtime", version, sha256, artifactPath, mount: "codex" }],
  };
  const manifestPath = join(root, "releases", version, `manifest-${target}.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath, archive: join(root, artifactPath) };
}

function source(root: string, cache: string, target: string) {
  return createBundledRemoteAssetSource(
    { bundledRemoteAssetsDir: root, remoteCacheDir: cache, version, platformArch: target },
    loggers,
  );
}

test("Host validation preserves the bundled root", () => {
  assert.deepEqual(
    remoteAssetDirsSchema.parse({
      bundledRemoteAssetsDir: "/resources/codex-remote",
      remoteCacheDir: "/cache",
    }),
    { bundledRemoteAssetsDir: "/resources/codex-remote", remoteCacheDir: "/cache" },
  );
});

test("real archives materialize codex mount in isolated target/SHA caches, with repair and concurrency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-bundled-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "cache");
  const paths = new Set<string>();
  for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    await fixture(root, target);
    const consumer = source(root, cache, target);
    const [first, second] = await Promise.all([
      consumer.materialize(["codex-runtime"]),
      consumer.materialize(["codex-runtime"]),
    ]);
    assert.equal(first, second);
    assert.equal(await readFile(join(first, "codex/codex"), "utf8"), target);
    paths.add(first);
    await writeFile(join(first, "codex/codex"), "corrupted cache");
    const repaired = await consumer.materialize(["codex-runtime"]);
    assert.equal(await readFile(join(repaired, "codex/codex"), "utf8"), target);
    assert.equal((await consumer.readManifest()).manifest.platformArch, target);
  }
  assert.equal(paths.size, 4, "fixed codex mount must never alias across targets");
  await fixture(root, "linux-x64", "new release same version");
  const refreshed = await source(root, cache, "linux-x64").materialize(["codex-runtime"]);
  assert.ok(!paths.has(refreshed));
  assert.equal(await readFile(join(refreshed, "codex/codex"), "utf8"), "new release same version");
});

test("bundled manifest, path, mount and SHA failures are closed without network fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-bundled-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "cache");
  const f = await fixture(root, "linux-x64");
  const consumer = source(root, cache, "linux-x64");
  await consumer.materialize(["codex-runtime"]);
  await writeFile(f.archive, "bad archive even with a warm cache");
  await assert.rejects(consumer.materialize(["codex-runtime"]), /sha256/i);
  await assert.rejects(source(root, cache, "darwin-arm64").readManifest(), /ENOENT/);
  for (const change of [
    { platformArch: "darwin-x64" },
    { components: [{ ...f.manifest.components[0]!, mount: "codex/linux-x64" }] },
    { components: [{ ...f.manifest.components[0]!, artifactPath: "../escape.tar.gz" }] },
    {
      components: [
        {
          ...f.manifest.components[0]!,
          artifactPath: `components/darwin-x64/codex-runtime/${f.manifest.components[0]!.sha256}.tar.gz`,
        },
      ],
    },
  ]) {
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, ...change }));
    await assert.rejects(source(root, cache, "linux-x64").readManifest());
  }
});

const realBundledRoot = process.env.CODEZ_TEST_BUNDLED_REMOTE_ASSETS_DIR;
test(
  "actual packaged linux-x64 archives pass consumer, real installer and shipped executables",
  {
    skip: !realBundledRoot || process.platform !== "linux" || process.arch !== "x64",
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "codez-bundled-native-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const metadata: { version: string } = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const target = "linux-x64";
    const consumer = createBundledRemoteAssetSource(
      {
        bundledRemoteAssetsDir: realBundledRoot!,
        remoteCacheDir: join(temporary, "cache"),
        version: metadata.version,
        platformArch: target,
      },
      loggers,
    );
    const release = await consumer.materialize();
    const contract: { files: Record<string, string> } = JSON.parse(
      await readFile(
        join(realBundledRoot!, "releases", metadata.version, `runtime-${target}.json`),
        "utf8",
      ),
    );
    const node = join(release, "node", target, "node");
    const server = join(release, "server/codez-server.cjs");
    for (const [file, expected] of Object.entries(contract.files)) {
      const materialized = file.startsWith("codex/")
        ? file
        : file.startsWith("prebuilds/")
          ? file.replace("prebuilds/", "node-pty/")
          : file.startsWith("tools/")
            ? file.replace("tools/", `tools/${target}/`)
            : ["node", "LICENSE.node.txt", "NODE-SOURCES.json"].includes(file)
              ? `node/${target}/${file}`
              : `server/${file}`;
      assert.equal(await computeFileSha256(join(release, materialized)), expected, materialized);
    }
    // 真正运行 installer 的 mkdir/upload/tar/chmod，无 SSH、无外部下载，所有路径仅在临时目录。
    const env = {
      PATH: process.env.PATH,
      HOME: temporary,
      CODEZ_DESKTOP_RUNTIME: "codex",
      CODEZ_DATA_BASE_DIR: join(temporary, "data"),
      CODEZ_CODEX_BRIDGE_HOME: join(temporary, "bridge-home"),
    };
    const backend: IRemoteBackend = {
      async detect() {
        return { platform: "linux", arch: "x64" };
      },
      async upload(local, remote) {
        await copyFile(local, resolvePosixHomePath(remote, temporary));
      },
      async exists(path) {
        try {
          await access(resolvePosixHomePath(path, temporary));
          return true;
        } catch {
          return false;
        }
      },
      async readFile(path) {
        return readFile(resolvePosixHomePath(path, temporary), "utf8");
      },
      async exec(command) {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd: temporary,
          env,
          stdio: "pipe",
          timeout: 30_000,
        });
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          onClose(listener) {
            const onClose = (code: number | null) => listener(code ?? -1);
            child.once("close", onClose);
            return {
              dispose() {
                child.off("close", onClose);
              },
            };
          },
        };
      },
      dispose() {},
    };
    // 未打包的 tsx 使用 0.0.0-dev；只调整测试 manifest 的 appVersion，制品 bytes/SHA 保持原样。
    const testRoot = join(temporary, "bundled");
    const manifest = (await consumer.readManifest()).manifest;
    for (const component of manifest.components) {
      const archive = join(testRoot, component.artifactPath);
      await mkdir(dirname(archive), { recursive: true });
      await copyFile(join(realBundledRoot!, component.artifactPath), archive);
    }
    const testManifest = join(testRoot, "releases", CODEZ_VERSION, `manifest-${target}.json`);
    await mkdir(dirname(testManifest), { recursive: true });
    await writeFile(testManifest, JSON.stringify({ ...manifest, appVersion: CODEZ_VERSION }));
    assert.equal(
      await deployServer(
        backend,
        { platform: "linux", arch: "x64" },
        {
          bundledRemoteAssetsDir: testRoot,
          remoteCacheDir: join(temporary, "deploy-cache"),
          force: true,
          deployLockMode: "caller-serialized",
          assetInstallMode: "remote-download",
          // 即使旧设置仍带 CDN，bundled 也只能读取本地归档。
          remoteCdnBaseUrl: "https://must-not-fetch.invalid",
          remoteAssetNetwork: {
            fetch: async () => {
              assert.fail("bundled deploy must not access CDN");
            },
          },
        },
      ),
      true,
    );
    const installedRoot = join(temporary, ".codez-codex/server");
    for (const name of ["node", "codez-server.cjs", "codex/codex", "codex/bridge.cjs"])
      assert.equal(await computeFileSha256(join(installedRoot, name)), contract.files[name], name);
    const run = promisify(execFile);
    assert.equal(
      (await run(node, ["--version"], { env, timeout: 15_000 })).stdout.trim(),
      "v24.14.0",
    );
    assert.equal(
      (
        await run(
          join(installedRoot, "node"),
          [join(installedRoot, "codez-server.cjs"), "--version"],
          { env, cwd: installedRoot, timeout: 15_000 },
        )
      ).stdout.trim(),
      metadata.version,
    );
    assert.match(
      (await run(join(installedRoot, "codex/codex"), ["--version"], { env, timeout: 15_000 }))
        .stdout,
      /codex/i,
    );
    await run(node, ["--check", join(installedRoot, "codex/bridge.cjs")], { env, timeout: 15_000 });
    assert.equal(await computeFileSha256(server), contract.files["codez-server.cjs"]);
    t.diagnostic(
      `real bundled consumer + installer: ${target}; Node v24.14.0, server ${metadata.version}, native Codex executable and bridge hashes verified`,
    );
  },
);
