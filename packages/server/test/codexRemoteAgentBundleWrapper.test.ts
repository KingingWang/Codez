import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";

// wrapper 部署根在模块加载时固定；测试进程固定选择 Codex flavor，不触碰真实远端。
process.env.CODEZ_DESKTOP_RUNTIME = "codex";
const { CODEZ_AGENT_RUNTIME } = await import("@codez/shared");
const { buildRemoteAgentBundleWrapper, isRemoteAgentBundleWrapperCurrent } =
  await import("../src/remote/codezAgentBundleWrapper.js");
const { deployCodezAgentRuntime } = await import("../src/remote/codezAgentDeploy.js");
const { resolveRemoteDataBaseDir, resolveRemoteRuntimeLayout } =
  await import("../src/remote/remoteRuntime.js");

const CODEX_LAYOUT = resolveRemoteRuntimeLayout({}, "codex");
const LEGACY_LAYOUT = resolveRemoteRuntimeLayout({}, "preview");
const RESOURCE_DIR = CODEZ_AGENT_RUNTIME.bundledResourceDir;
const sha = "a".repeat(64);
const loggers = { log() {}, logWarn() {} };

const CODEX_WRAPPER = [
  "#!/bin/sh",
  "set -eu",
  'runtime_root="${CODEZ_SERVER_RUNTIME_ROOT:-$HOME/.codez-codex/server}"',
  `exec "$runtime_root/node" "$runtime_root/agents/${RESOURCE_DIR}/codez.cjs" "$@"`,
  "",
].join("\n");
const LEGACY_WRAPPER = [
  "#!/bin/sh",
  "set -eu",
  'runtime_root="${CODEZ_SERVER_RUNTIME_ROOT:-$HOME/.codez/server}"',
  `exec "$runtime_root/node" "$runtime_root/agents/${RESOURCE_DIR}/codez.cjs" "$@"`,
  "",
].join("\n");
// 隔离修复前的历史 wrapper：exec 行硬编码 $HOME/.codez/server，泄漏到上游目录。
const PRE_FIX_WRAPPER = [
  "#!/bin/sh",
  "set -eu",
  'runtime_root="${CODEZ_SERVER_RUNTIME_ROOT:-$HOME/.codez/server}"',
  `exec "$runtime_root/node" "$HOME/.codez/server/agents/${RESOURCE_DIR}/codez.cjs" "$@"`,
  "",
].join("\n");

test("wrapper text derives node and bundle paths from one flavor runtime_root", () => {
  assert.equal(buildRemoteAgentBundleWrapper(RESOURCE_DIR, CODEX_LAYOUT), CODEX_WRAPPER);
  assert.equal(buildRemoteAgentBundleWrapper(RESOURCE_DIR, LEGACY_LAYOUT), LEGACY_WRAPPER);
  for (const wrapper of [CODEX_WRAPPER, LEGACY_WRAPPER]) {
    // runtime_root 单次赋值；node 与 agents 产物路径都从它派生。
    assert.equal(wrapper.match(/runtime_root=/g)?.length, 1);
    assert.equal(wrapper.match(/"\$runtime_root\//g)?.length, 2);
    // $HOME 必须保留 shell 展开；任何位置都不得出现字面量 ~。
    assert.match(wrapper, /\$HOME\//);
    assert.ok(!wrapper.includes("~"));
    assert.ok(!wrapper.includes("'~"));
  }
});

test("default layout honors CODEZ_DESKTOP_RUNTIME at generation time", () => {
  const previous = process.env.CODEZ_DESKTOP_RUNTIME;
  try {
    process.env.CODEZ_DESKTOP_RUNTIME = "codex";
    assert.equal(buildRemoteAgentBundleWrapper(RESOURCE_DIR), CODEX_WRAPPER);
    process.env.CODEZ_DESKTOP_RUNTIME = "legacy";
    assert.equal(buildRemoteAgentBundleWrapper(RESOURCE_DIR), LEGACY_WRAPPER);
  } finally {
    process.env.CODEZ_DESKTOP_RUNTIME = previous;
  }
  assert.equal(
    resolveRemoteRuntimeLayout({ CODEZ_DESKTOP_RUNTIME: "codex" }, "preview").root,
    "~/.codez-codex/server",
  );
  assert.equal(
    resolveRemoteRuntimeLayout({ CODEZ_DESKTOP_RUNTIME: "legacy" }, "codex").root,
    "~/.codez/server",
  );
});

test("data base dir follows the flavor layout root", () => {
  assert.equal(resolveRemoteDataBaseDir(CODEX_LAYOUT), "~/.codez-codex");
  assert.equal(resolveRemoteDataBaseDir(LEGACY_LAYOUT), "~/.codez");
  assert.equal(
    resolveRemoteDataBaseDir(resolveRemoteRuntimeLayout({ CODEZ_DESKTOP_RUNTIME: "codex" })),
    "~/.codez-codex",
  );
});

test("wrapper currency: current content matches, pre-fix content is stale", () => {
  assert.equal(isRemoteAgentBundleWrapperCurrent(CODEX_WRAPPER, RESOURCE_DIR, CODEX_LAYOUT), true);
  assert.equal(
    isRemoteAgentBundleWrapperCurrent(LEGACY_WRAPPER, RESOURCE_DIR, LEGACY_LAYOUT),
    true,
  );
  // CRLF 归一化保持既有语义。
  assert.equal(
    isRemoteAgentBundleWrapperCurrent(
      CODEX_WRAPPER.replace(/\n/g, "\r\n"),
      RESOURCE_DIR,
      CODEX_LAYOUT,
    ),
    true,
  );
  // 历史 wrapper 在两种 flavor 下都不算 current，下一次部署必定重写。
  assert.equal(
    isRemoteAgentBundleWrapperCurrent(PRE_FIX_WRAPPER, RESOURCE_DIR, CODEX_LAYOUT),
    false,
  );
  assert.equal(
    isRemoteAgentBundleWrapperCurrent(PRE_FIX_WRAPPER, RESOURCE_DIR, LEGACY_LAYOUT),
    false,
  );
});

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

function deployFixture(remoteWrapper: string) {
  const root = "~/.codez-codex/server";
  const providerDir = `${root}/agents/${RESOURCE_DIR}`;
  const binaryPath = `${providerDir}/codez-agent`;
  const commands: string[] = [];
  const installs: string[] = [];
  const backend: IRemoteBackend = {
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async upload() {},
    async exists() {
      return true;
    },
    async readFile(path) {
      if (path === binaryPath) return remoteWrapper;
      if (path.endsWith(`/agents/${RESOURCE_DIR}/.version`)) return CODEZ_AGENT_RUNTIME.version;
      // live component meta：SHA 与 manifest 一致，让跳过决策只取决于 wrapper 内容。
      return JSON.stringify({
        id: CODEZ_AGENT_RUNTIME.bundledResourceDir,
        version: CODEZ_AGENT_RUNTIME.version,
        sha256: sha,
        platformArch: "linux-x64",
      });
    },
    async exec(command) {
      commands.push(command);
      return stream();
    },
    dispose() {},
  };
  const installer: RemoteAssetInstaller = {
    mode: "local-download-upload",
    async resolveComponentSha256() {
      return sha;
    },
    async installFile(params) {
      installs.push(`file:${params.remotePath}`);
    },
    async installDirectory(params) {
      installs.push(`dir:${params.remoteDir}`);
    },
  };
  return { backend, installer, commands, installs, binaryPath };
}

test("non-WSL backend rewrites a stale wrapper instead of skipping deploy", async () => {
  const f = deployFixture(PRE_FIX_WRAPPER);
  await deployCodezAgentRuntime(
    f.backend,
    { platform: "linux", arch: "x64" },
    { installer: f.installer, platformArch: "linux-x64" },
    loggers,
  );
  assert.ok(f.installs.some((entry) => entry.endsWith("codez.cjs")));
  // wrapper 重写走远端 shell 写入 + 可执行替换。
  assert.ok(
    f.commands.some(
      (command) =>
        command.includes("codez-agent.new") &&
        command.includes('runtime_root="${CODEZ_SERVER_RUNTIME_ROOT:-$HOME/.codez-codex/server}"'),
    ),
  );
});

test("non-WSL backend skips deploy when the wrapper is already current", async () => {
  const f = deployFixture(CODEX_WRAPPER);
  await deployCodezAgentRuntime(
    f.backend,
    { platform: "linux", arch: "x64" },
    { installer: f.installer, platformArch: "linux-x64" },
    loggers,
  );
  assert.deepEqual(f.installs, []);
  assert.ok(f.commands.every((command) => !command.includes("codez-agent.new")));
});
