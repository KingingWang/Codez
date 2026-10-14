import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createTarGzArchive } from "../src/remote/localTarGz.js";
import { createCodexReleaseRemoteAssetSource } from "../src/remote/codexReleaseRemoteAssets.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const tag = "codez-build-123-aaaaaaaaaaaa";
const target = "linux-x64";
const version = "3.15.1";
const loggers = { log() {}, logWarn() {} };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codex-release-asset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagedRemoteAssetsDir = join(root, "package");
  const remoteCacheDir = join(root, "cache");
  const native = join(root, "native");
  for (const file of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-package.json",
    "codex-path/rg",
  ]) {
    const path = join(native, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file);
  }
  const archive = join(root, "archive.tar.gz");
  await createTarGzArchive(
    archive,
    ["bin", "codex-package.json", "codex-path"].map((name) => ({
      sourcePath: join(native, name),
      archivePath: name,
    })),
  );
  const archiveBytes = await readFile(archive);
  const artifactPath = `components/${target}/codex-native/${sha(archiveBytes)}.tar.gz`;
  const assetName = `codex-remote-${target}-codex-native-${sha(archiveBytes)}.tar.gz`;
  const manifest = {
    schemaVersion: 1,
    appVersion: version,
    platformArch: target,
    components: [
      {
        id: "codex-native",
        version: "codex-test",
        sha256: sha(archiveBytes),
        artifactPath,
        mount: "codex",
      },
    ],
  };
  const manifestBytes = JSON.stringify(manifest);
  const index = {
    schemaVersion: 1,
    appVersion: version,
    releaseTag: tag,
    manifests: {
      "darwin-x64": "a".repeat(64),
      "darwin-arm64": "b".repeat(64),
      "linux-x64": sha(manifestBytes),
      "linux-arm64": "c".repeat(64),
    },
    assets: { [artifactPath]: assetName },
    files: {
      "linux-x64": Object.fromEntries(
        [
          "bin/codex",
          "bin/codex-code-mode-host",
          "codex-package.json",
          "codex-path/rg",
          "bridge.cjs",
          "distribution.json",
        ].map((file) => [`codex/${file}`, sha(file)]),
      ),
    },
  };
  await mkdir(join(packagedRemoteAssetsDir, "releases", version), { recursive: true });
  await writeFile(join(packagedRemoteAssetsDir, "index.json"), JSON.stringify(index));
  await writeFile(
    join(packagedRemoteAssetsDir, "releases", version, `manifest-${target}.json`),
    manifestBytes,
  );
  return {
    root,
    packagedRemoteAssetsDir,
    remoteCacheDir,
    archiveBytes,
    artifactPath,
    assetName,
    index,
  };
}

test("packaged pinned manifest needs no network when the verified sidecar is present", async (t) => {
  const f = await fixture(t);
  const imported = join(f.remoteCacheDir, "imports", tag);
  await mkdir(join(imported, "components", target, "codex-native"), { recursive: true });
  await writeFile(join(imported, "index.json"), JSON.stringify(f.index));
  await writeFile(join(imported, f.artifactPath), f.archiveBytes);
  const source = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      remoteAssetNetwork: { fetch: async () => assert.fail("sidecar should avoid network") },
    },
    loggers,
  );
  assert.equal((await source.readManifest()).manifest.components[0]?.id, "codex-native");
  const release = await source.materialize(["codex-native"]);
  assert.equal(await readFile(join(release, "codex/bin/codex"), "utf8"), "bin/codex");
  assert.equal(await source.materialize(["codex-native"]), release);
});

test("local development checkout uses verified archives inside packagedRemoteAssetsDir without network", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.packagedRemoteAssetsDir, "components", target, "codex-native"), {
    recursive: true,
  });
  await writeFile(join(f.packagedRemoteAssetsDir, f.artifactPath), f.archiveBytes);
  const source = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      remoteAssetNetwork: {
        fetch: async () => assert.fail("local checkout archives should avoid network"),
      },
    },
    loggers,
  );
  const release = await source.materialize(["codex-native"]);
  assert.equal(await readFile(join(release, "codex/bin/codex"), "utf8"), "bin/codex");
});

test("missing sidecar downloads only the selected target from the pinned release", async (t) => {
  const f = await fixture(t);
  const requests: string[] = [];
  const source = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      remoteAssetNetwork: {
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(f.archiveBytes);
        },
      },
    },
    loggers,
  );
  await source.materialize(["codex-native"]);
  assert.deepEqual(requests, [
    `https://github.com/KingingWang/Codez/releases/download/${tag}/${f.assetName}`,
  ]);
});

test("corrupt imported sidecar fails closed rather than fetching an unrelated artifact", async (t) => {
  const f = await fixture(t);
  const imported = join(f.remoteCacheDir, "imports", tag);
  await mkdir(join(imported, "components", target, "codex-native"), { recursive: true });
  await writeFile(join(imported, "index.json"), JSON.stringify(f.index));
  await writeFile(join(imported, f.artifactPath), "corrupt");
  const source = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      remoteAssetNetwork: { fetch: async () => assert.fail("corruption must not fetch") },
    },
    loggers,
  );
  await assert.rejects(source.materialize(["codex-native"]), /sha/i);
});

test("two connections publish the same verified release without exposing partial archives", async (t) => {
  const f = await fixture(t);
  let fetchCount = 0;
  let releaseFetch!: () => void;
  const allowFetchFinish = new Promise<void>((resolve) => (releaseFetch = resolve));
  const firstController = new AbortController();
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (markFetchStarted = resolve));
  const options = {
    packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
    remoteCacheDir: f.remoteCacheDir,
    version,
    platformArch: target,
    remoteAssetNetwork: {
      fetch: async () => {
        fetchCount += 1;
        markFetchStarted();
        await allowFetchFinish;
        return new Response(f.archiveBytes);
      },
    },
  };
  const first = createCodexReleaseRemoteAssetSource(
    { ...options, signal: firstController.signal },
    loggers,
  );
  const second = createCodexReleaseRemoteAssetSource(options, loggers);
  const firstPromise = first.materialize(["codex-native"]);
  await fetchStarted;
  const secondPromise = second.materialize(["codex-native"]);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  // 第一个连接取消时，第二个连接仍在等待，共享下载不能被中止，且全程只发起一次请求。
  firstController.abort();
  await assert.rejects(firstPromise, /abort/i);
  releaseFetch();
  const right = await secondPromise;
  assert.equal(fetchCount, 1);
  assert.equal(await readFile(join(right, "codex/bin/codex"), "utf8"), "bin/codex");
  const third = await createCodexReleaseRemoteAssetSource(options, loggers).materialize([
    "codex-native",
  ]);
  assert.equal(third, right);
  assert.equal(fetchCount, 1);
  const componentDir = join(
    f.remoteCacheDir,
    "release-sources",
    tag,
    "components",
    target,
    "codex-native",
  );
  assert.deepEqual(await readdir(componentDir), [`${sha(f.archiveBytes)}.tar.gz`]);
});

test("canceled release download leaves no published archive and can be retried", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const aborted = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      signal: controller.signal,
      remoteAssetNetwork: {
        fetch: async () => {
          const body = new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(f.archiveBytes.subarray(0, 8));
              queueMicrotask(() => controller.abort());
            },
          });
          return new Response(body);
        },
      },
    },
    loggers,
  );
  await assert.rejects(aborted.materialize(["codex-native"]), /abort/i);
  const retry = createCodexReleaseRemoteAssetSource(
    {
      packagedRemoteAssetsDir: f.packagedRemoteAssetsDir,
      remoteCacheDir: f.remoteCacheDir,
      version,
      platformArch: target,
      remoteAssetNetwork: { fetch: async () => new Response(f.archiveBytes) },
    },
    loggers,
  );
  const release = await retry.materialize(["codex-native"]);
  assert.equal(await readFile(join(release, "codex/bin/codex"), "utf8"), "bin/codex");
});
