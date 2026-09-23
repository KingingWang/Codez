import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CODEZ_VERSION } from "@codez/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";

// 模块级部署根与产品构建绑定；测试进程单独选择 Codex，不修改真实远端或用户目录。
process.env.CODEZ_DESKTOP_RUNTIME = "codex";
const { resolveRemoteRuntimeLayout } = await import("../src/remote/remoteRuntime.js");
const { buildRemoteServerCommand } = await import("../src/remote/connect.js");
const { deployCodexRuntime, assertCodexRemoteNodeVersion, assertCodexRemoteEnvironment } =
  await import("../src/remote/codexRuntimeDeploy.js");
const { parseRemoteAssetManifestFromResponse, usesRemoteAssetContentAddressedCacheIdentity } =
  await import("../src/remote/remoteAssetCache.js");
const { deployServer } = await import("../src/remote/deploy.js");
const { LocalUploadAssetInstaller, RemoteDownloadAssetInstaller } =
  await import("../src/remote/remoteAssetInstaller.js");

const root = "~/.codez-codex/server";
const sha = "a".repeat(64);
const loggers = { log() {}, logWarn() {} };

function stream(stdoutText = "", exitCode = 0): StdioStream {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    onClose(listener) {
      queueMicrotask(() => {
        stdout.end(stdoutText);
        stderr.end();
        listener(exitCode);
      });
      return { dispose() {} };
    },
  };
}

function fixture() {
  const files = new Set(
    ["codex", "bridge.cjs", "distribution.json"].map((p) => `${root}/codex/${p}`),
  );
  const commands: string[] = [];
  const installs: Parameters<RemoteAssetInstaller["installDirectory"]>[0][] = [];
  let metadata = JSON.stringify({ id: "codex-runtime", platformArch: "linux-arm64", sha256: sha });
  const backend: IRemoteBackend = {
    async detect() {
      return { platform: "linux", arch: "arm64" };
    },
    async upload() {
      assert.fail("fake installer never uploads");
    },
    async exists(path) {
      return files.has(path);
    },
    async readFile() {
      return metadata;
    },
    async exec(command) {
      commands.push(command);
      return stream("v24.14.0\n");
    },
    dispose() {},
  };
  const installer: RemoteAssetInstaller = {
    mode: "local-download-upload",
    async resolveComponentSha256() {
      return sha;
    },
    async installFile() {
      assert.fail("Codex is installed as one verified component");
    },
    async installDirectory(params) {
      installs.push(params);
      for (const p of params.requiredRelativePaths ?? []) files.add(`${params.remoteDir}/${p}`);
    },
  };
  return {
    backend,
    installer,
    files,
    commands,
    installs,
    setMetadata(value: string) {
      metadata = value;
    },
  };
}

test("product runtime layout isolates Codex while explicit legacy retains its root", () => {
  assert.deepEqual(resolveRemoteRuntimeLayout({ CODEZ_DESKTOP_RUNTIME: "codex" }, "preview"), {
    kind: "codex",
    root,
  });
  assert.deepEqual(resolveRemoteRuntimeLayout({}, "codex"), { kind: "codex", root });
  assert.deepEqual(resolveRemoteRuntimeLayout({ CODEZ_DESKTOP_RUNTIME: "legacy" }, "codex"), {
    kind: "legacy",
    root: "~/.codez/server",
  });
  assert.equal(resolveRemoteRuntimeLayout({}, "preview").kind, "legacy");
});

test("startup expands remote home, preserves network authority, and never forwards local native paths", () => {
  const command = buildRemoteServerCommand(
    {
      remoteRuntimeEnv: {
        CODEZ_CODEX_COMMAND: "/desktop/codex",
        CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED: "0",
      },
      appVersion: "1.0'quoted",
    },
    { authoritative: true, httpProxy: "http://127.0.0.1:18080", noProxy: "localhost" },
  );
  assert.match(command, /CODEZ_CODEX_COMMAND="\$HOME"'\/\.codez-codex\/server\/codex\/codex'/);
  assert.match(
    command,
    /CODEZ_CODEX_BRIDGE_PATH="\$HOME"'\/\.codez-codex\/server\/codex\/bridge.cjs'/,
  );
  assert.match(command, /CODEZ_CODEX_BRIDGE_HOME="\$HOME"'\/\.codez-codex\/bridge'/);
  assert.match(command, /desktop-attached-remote/);
  assert.match(command, /http:\/\/127.0.0.1:18080/);
  assert.match(command, /CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED='0'/);
  assert.ok(
    command.endsWith(
      `"$HOME"'/.codez-codex/server/node' "$HOME"'/.codez-codex/server/codez-server.cjs'`,
    ),
  );
  assert.doesNotMatch(command, /\/desktop\/|app-server|--surface|--prepare-storage|glm/);
});

test("Codex manifests accept only the codex mount and use SHA-addressed cache identity", async () => {
  const manifest = {
    schemaVersion: 1,
    appVersion: "1.0.0",
    platformArch: "linux-arm64",
    components: [
      {
        id: "codex-runtime",
        version: "1.0.0",
        sha256: sha,
        artifactPath: "components/codex.tar.gz",
        mount: "codex",
      },
    ],
  };
  const parsed = await parseRemoteAssetManifestFromResponse(
    new Response(JSON.stringify(manifest)),
    "fixture",
    "1.0.0",
    "linux-arm64",
  );
  assert.equal(parsed.components[0]?.id, "codex-runtime");
  assert.equal(usesRemoteAssetContentAddressedCacheIdentity("codex-runtime"), true);
  manifest.components[0]!.mount = "../codex";
  await assert.rejects(
    parseRemoteAssetManifestFromResponse(
      new Response(JSON.stringify(manifest)),
      "fixture",
      "1.0.0",
      "linux-arm64",
    ),
  );
});

test("Codex targets use remote OS/arch and reject unsupported platforms", () => {
  for (const platform of ["linux", "darwin"])
    for (const arch of ["x64", "arm64"]) assertCodexRemoteEnvironment({ platform, arch });
  for (const env of [
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "ia32" },
  ])
    assert.throws(() => assertCodexRemoteEnvironment(env), /unsupported/i);
});

test("matching Codex SHA and required files skip installation", async () => {
  const f = fixture();
  await deployCodexRuntime(
    f.backend,
    { installer: f.installer, platformArch: "linux-arm64" },
    loggers,
  );
  assert.equal(f.installs.length, 0);
});

test("missing file, changed SHA, or forced refresh replaces the whole component", async () => {
  for (const reason of ["missing", "sha", "force"] as const) {
    const f = fixture();
    if (reason === "missing") f.files.delete(`${root}/codex/bridge.cjs`);
    if (reason === "sha")
      f.setMetadata(
        JSON.stringify({
          id: "codex-runtime",
          platformArch: "linux-arm64",
          sha256: "b".repeat(64),
        }),
      );
    await deployCodexRuntime(
      f.backend,
      { installer: f.installer, platformArch: "linux-arm64", force: reason === "force" },
      loggers,
    );
    assert.deepEqual(f.installs, [
      {
        componentId: "codex-runtime",
        sourceRelativePath: "codex",
        remoteDir: `${root}/codex`,
        requiredRelativePaths: ["codex", "bridge.cjs", "distribution.json"],
        forceRefresh: reason === "force",
      },
    ]);
    assert.ok(f.commands.some((c) => c.includes("chmod +x")));
    assert.ok(f.commands.some((c) => c.includes(".asset-components") && c.includes(sha)));
    assert.ok(f.commands.every((c) => !c.includes("glm")));
  }
});

test("failed install or missing manifest SHA cannot write a success marker", async () => {
  const f = fixture();
  f.installer.installDirectory = async () => {
    throw new Error("interrupted transfer");
  };
  await assert.rejects(
    deployCodexRuntime(
      f.backend,
      { installer: f.installer, platformArch: "linux-arm64", force: true },
      loggers,
    ),
    /interrupted transfer/,
  );
  assert.equal(f.commands.length, 0);
  f.installer.resolveComponentSha256 = async () => null;
  await assert.rejects(
    deployCodexRuntime(f.backend, { installer: f.installer, platformArch: "linux-arm64" }, loggers),
    /SHA/,
  );
});

test("incomplete install and cancellation cannot commit a Codex identity", async () => {
  for (const canceled of [false, true]) {
    const f = fixture();
    const abort = new AbortController();
    f.files.delete(`${root}/codex/bridge.cjs`);
    f.installer.installDirectory = async () => {
      if (canceled) abort.abort();
    };
    await assert.rejects(
      deployCodexRuntime(
        f.backend,
        { installer: f.installer, platformArch: "linux-arm64", signal: abort.signal },
        loggers,
      ),
    );
    assert.equal(f.commands.length, 0);
  }
});

test("native Node pin is checked from executable output, not a component content version", async () => {
  const f = fixture();
  await assertCodexRemoteNodeVersion(f.backend);
  f.backend.exec = async () => stream("v22.0.0\n");
  await assert.rejects(assertCodexRemoteNodeVersion(f.backend), /24.14.0/);
  f.backend.exec = async () => stream("v24.14.0\n", 1);
  await assert.rejects(assertCodexRemoteNodeVersion(f.backend), /exit code/);
});

test("existing Node/server pipeline selects Codex, never GLM, for new and matching remote servers", async (t) => {
  for (const mode of ["local-download-upload", "remote-download"] as const) {
    for (const platform of ["linux", "darwin"]) {
      for (const arch of ["x64", "arm64"]) {
        await t.test(`${mode}/${platform}-${arch}`, async (t) => {
          const cache = await mkdtemp(join(tmpdir(), "codez-codex-remote-cache-"));
          t.after(() => rm(cache, { recursive: true, force: true }));
          const platformArch = `${platform}-${arch}`;
          const matchingServer = arch === "arm64";
          const f = fixture();
          const installed: string[] = [];
          f.files.delete(`${root}/codex/bridge.cjs`);
          if (matchingServer) {
            f.files.add(`${root}/node`);
            f.files.add(`${root}/codez-server.cjs`);
          }
          f.backend.readFile = async (path) => {
            const id = path
              .split("/")
              .at(-1)
              ?.replace(/\.json$/, "");
            return JSON.stringify({ id, platformArch, sha256: sha, version: "fixture-version" });
          };
          f.backend.exec = async (command) => {
            f.commands.push(command);
            return stream(
              command.endsWith("--version")
                ? command.includes("codez-server.cjs")
                  ? CODEZ_VERSION
                  : "v24.14.0"
                : command.includes("command -v curl")
                  ? "download=curl\ntar=tar\nsha256=sha256sum\n"
                  : "",
            );
          };
          t.mock.method(
            (mode === "remote-download" ? RemoteDownloadAssetInstaller : LocalUploadAssetInstaller)
              .prototype,
            "resolveComponentVersion",
            async () => "fixture-version",
          );
          t.mock.method(
            LocalUploadAssetInstaller.prototype,
            "tryResolveLocalPath",
            async () => "/fixture",
          );
          t.mock.method(
            (mode === "remote-download" ? RemoteDownloadAssetInstaller : LocalUploadAssetInstaller)
              .prototype,
            "installFile",
            async (params: Parameters<RemoteAssetInstaller["installFile"]>[0]) => {
              installed.push(params.componentId);
              f.files.add(params.remotePath);
            },
          );
          t.mock.method(
            (mode === "remote-download" ? RemoteDownloadAssetInstaller : LocalUploadAssetInstaller)
              .prototype,
            "installDirectory",
            async (params: Parameters<RemoteAssetInstaller["installDirectory"]>[0]) => {
              installed.push(params.componentId);
              for (const file of params.requiredRelativePaths ?? [])
                f.files.add(`${params.remoteDir}/${file}`);
            },
          );
          const manifest = {
            schemaVersion: 1,
            appVersion: CODEZ_VERSION,
            platformArch,
            components: [
              { id: "server-bundle", mount: "server" },
              { id: "codex-runtime", mount: "codex" },
              { id: "node-runtime", mount: `node/${platformArch}` },
              { id: "node-pty", mount: `node-pty/${platformArch}` },
              ...["bfs", "ripgrep", "ugrep"].map((id) => ({
                id,
                mount: `tools/${platformArch}/${id}`,
              })),
            ].map((component) => ({
              ...component,
              version: "1.0.0",
              sha256: sha,
              artifactPath: `components/${component.id}.tar.gz`,
            })),
          };
          const deployed = await deployServer(
            f.backend,
            { platform, arch },
            {
              deployLockMode: "caller-serialized",
              assetInstallMode: mode,
              remoteCdnBaseUrl: "https://assets.invalid",
              remoteCacheDir: cache,
              remoteAssetNetwork: { fetch: async () => new Response(JSON.stringify(manifest)) },
            },
          );
          assert.equal(deployed, !matchingServer);
          assert.ok(installed.includes("codex-runtime"));
          assert.equal(installed.includes("server-bundle"), !matchingServer);
          assert.ok(installed.includes("node-pty"));
          assert.ok(!installed.includes("glm"));
          assert.ok(
            f.commands.some(
              (command) => command.endsWith("--version") && !command.includes("codez-server.cjs"),
            ),
          );
          assert.ok(
            f.commands.every(
              (command) => !command.includes("/.codez/server") && !command.includes("glm"),
            ),
          );
        });
      }
    }
  }
});
