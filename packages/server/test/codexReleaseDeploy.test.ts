import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CODEZ_VERSION } from "@codez/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";

process.env.CODEZ_DESKTOP_RUNTIME = "codex";
const { deployServer } = await import("../src/remote/deploy.js");
const { LocalUploadAssetInstaller, RemoteDownloadAssetInstaller } =
  await import("../src/remote/remoteAssetInstaller.js");
const { RemoteAssetSourceUnavailableError } = await import("../src/remote/remoteAssetPreflight.js");

const target = "linux-x64";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function stream(text = ""): StdioStream {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    onClose(listener) {
      queueMicrotask(() => {
        stdout.end(text);
        stderr.end();
        listener(0);
      });
      return { dispose() {} };
    },
  };
}

test("packaged Codex remote-download falls back once; matching reconnect transfers no native package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-release-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagedRemoteAssetsDir = join(root, "package");
  const remoteCacheDir = join(root, "cache");
  const components = [
    ["server-bundle", "server"],
    ["node-runtime", `node/${target}`],
    ["node-pty", `node-pty/${target}`],
    ["codex-native", "codex"],
    ["codex-bridge", "codex-bridge"],
    ...["bfs", "ripgrep", "ugrep"].map((id) => [id, `tools/${target}/${id}`]),
  ].map(([id, mount]) => {
    const digest = sha(id);
    return {
      id,
      mount,
      version: `${id}+${digest.slice(0, 12)}`,
      sha256: digest,
      artifactPath: `components/${target}/${id}/${digest}.tar.gz`,
    };
  });
  const manifest = JSON.stringify({
    schemaVersion: 1,
    appVersion: CODEZ_VERSION,
    platformArch: target,
    components,
  });
  const relative = `releases/${CODEZ_VERSION}/manifest-${target}.json`;
  await mkdir(join(packagedRemoteAssetsDir, "releases", CODEZ_VERSION), { recursive: true });
  await writeFile(join(packagedRemoteAssetsDir, relative), manifest);
  await writeFile(
    join(packagedRemoteAssetsDir, "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: CODEZ_VERSION,
      releaseTag: "codez-build-123-aaaaaaaaaaaa",
      manifests: {
        "darwin-x64": "a".repeat(64),
        "darwin-arm64": "b".repeat(64),
        [target]: sha(manifest),
        "linux-arm64": "c".repeat(64),
      },
      assets: Object.fromEntries(
        components.map(({ id, artifactPath, sha256 }) => [
          artifactPath,
          `codex-remote-${target}-${id}-${sha256}.tar.gz`,
        ]),
      ),
      files: {
        [target]: Object.fromEntries(
          [
            "bin/codex",
            "bin/codex-code-mode-host",
            "codex-package.json",
            "codex-path/rg",
            "bridge.cjs",
            "distribution.json",
          ].map((name) => [`codex/${name}`, sha(name)]),
        ),
      },
    }),
  );
  const files = new Set<string>();
  const meta = new Map<string, string>();
  const uploads: string[] = [];
  const remoteAttempts: string[] = [];
  const backend: IRemoteBackend = {
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async exists(path) {
      return files.has(path);
    },
    async readFile(path) {
      const id = path.split("/").at(-1)?.replace(".json", "") ?? "";
      const value = meta.get(id);
      if (!value) throw new Error("missing component marker");
      return value;
    },
    async upload() {
      assert.fail("stubbed installers own the upload receipt");
    },
    async exec(command) {
      const marker = /\{"id":"[^"]+".*?\}/.exec(command)?.[0];
      if (marker) {
        const value = JSON.parse(marker) as { id: string };
        meta.set(value.id, marker);
      }
      return stream(
        command.includes("command -v curl")
          ? "download=curl\ntar=tar\nsha256=sha256sum\n"
          : command.includes("codez-server.cjs") && command.includes("--version")
            ? CODEZ_VERSION
            : command.includes("--version")
              ? "v24.14.0\n"
              : "",
      );
    },
    dispose() {},
  };
  t.mock.method(
    RemoteDownloadAssetInstaller.prototype,
    "installFile",
    async (params: Parameters<RemoteAssetInstaller["installFile"]>[0]) => {
      remoteAttempts.push(params.componentId);
      throw new RemoteAssetSourceUnavailableError("remote GitHub unavailable");
    },
  );
  t.mock.method(
    RemoteDownloadAssetInstaller.prototype,
    "installDirectory",
    async (params: Parameters<RemoteAssetInstaller["installDirectory"]>[0]) => {
      remoteAttempts.push(params.componentId);
      throw new RemoteAssetSourceUnavailableError("remote GitHub unavailable");
    },
  );
  t.mock.method(
    LocalUploadAssetInstaller.prototype,
    "installFile",
    async (params: Parameters<RemoteAssetInstaller["installFile"]>[0]) => {
      uploads.push(params.componentId);
      files.add(params.remotePath);
    },
  );
  t.mock.method(
    LocalUploadAssetInstaller.prototype,
    "installDirectory",
    async (params: Parameters<RemoteAssetInstaller["installDirectory"]>[0]) => {
      uploads.push(params.componentId);
      for (const name of params.requiredRelativePaths ?? [])
        files.add(`${params.remoteDir}/${name}`);
    },
  );
  const options = {
    packagedRemoteAssetsDir,
    remoteCacheDir,
    assetInstallMode: "remote-download" as const,
    deployLockMode: "caller-serialized" as const,
    remoteAssetNetwork: { fetch: async () => assert.fail("stubbed transfer must not fetch") },
  };
  assert.equal(await deployServer(backend, { platform: "linux", arch: "x64" }, options), true);
  assert.deepEqual(remoteAttempts, ["node-runtime"]);
  assert.ok(uploads.includes("codex-native"));
  assert.ok(uploads.includes("codex-bridge"));
  uploads.length = 0;
  remoteAttempts.length = 0;
  await deployServer(backend, { platform: "linux", arch: "x64" }, options);
  assert.ok(!uploads.includes("codex-native"));
  assert.ok(!remoteAttempts.includes("codex-native"));
});
