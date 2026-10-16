#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { discoverNodeUnitTests, isNodeTestFile } from "./unit-test-frameworks.mjs";

const ROOT_UNIT_E2E_GLOB = "packages/desktop/test/e2e/**/*.test.ts";

function resolvePnpmCliPath(env) {
  const npmExecPath = env.npm_execpath;
  if (
    npmExecPath &&
    (npmExecPath.toLowerCase().includes("\\pnpm\\") || npmExecPath.toLowerCase().includes("/pnpm/"))
  ) {
    return npmExecPath;
  }

  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = join(pathEntry, "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function spawnPnpm(args, options) {
  // Bugfix: Windows 下不能把文件参数拼成 cmd.exe 字符串；%PATH% 这类合法文件名
  // 会被 shell 展开。pre-push 专用 runner 在 Windows 下直接走 pnpm JS 入口，保持 argv 原样传递。
  if (process.platform !== "win32") {
    return spawnSync("pnpm", args, options);
  }

  const cliPath = resolvePnpmCliPath(options.env ?? process.env);
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], options);
  }

  return spawnSync("pnpm", args, { ...options, shell: true });
}

function collectGitLocalEnvNames() {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function createCleanGitEnv() {
  const env = { ...process.env };

  // lint-staged 在 pre-push 路径下使用临时 GIT_INDEX_FILE 保护真实 index。
  // Vitest 及单测中的临时 Git 仓库不应继承这些 local env，否则会误命中当前仓库。
  for (const name of collectGitLocalEnvNames()) {
    delete env[name];
  }

  // 在 Codez Desktop 内置终端或 Agent 会话中执行 pre-push / test:unit 时，宿主注入的
  // CODEZ_* 运行时变量会污染单测对默认环境/flavor/目录的断言，这里统一剥离宿主运行态变量。
  for (const name of [
    "CODEZ_APP_VERSION",
    "CODEZ_BASE_URL",
    "CODEZ_BFS_BINARY",
    "CODEZ_BUILD_COMMIT_ID",
    "CODEZ_CODEX_BLOCKED_PROVIDER_IDS",
    "CODEZ_CODEX_BRIDGE_HOME",
    "CODEZ_CODEX_COMMAND",
    "CODEZ_CODEX_UPDATE_PLAN_ENABLED",
    "CODEZ_CUA_BUNDLED_HELPER_APP_PATH",
    "CODEZ_CUA_HELPER_INSTALL_VARIANT",
    "CODEZ_CUA_LAUNCHER_PID",
    "CODEZ_DATA_BASE_DIR",
    "CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED",
    "CODEZ_DESKTOP_MCP_SERVERS",
    "CODEZ_DESKTOP_RUNTIME",
    "CODEZ_ENV",
    "CODEZ_GEN_UI_OUTPUT_ROOT",
    "CODEZ_HOME",
    "CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE",
    "CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE",
    "CODEZ_PROCESS_LABEL",
    "CODEZ_RG_BINARY",
    "CODEZ_RUNTIME_ENV",
    "CODEZ_TOOL_ENV_PASSTHROUGH_JSON",
    "CODEZ_UGREP_BINARY",
    "CODEZ_WORKSPACE_IDENTITY",
  ]) {
    delete env[name];
  }

  // macOS 默认 TMPDIR (/var/folders/...) 路径较长且为 /private/var 的符号链接：
  // 1) Unix domain socket 测试拼接长文件名会超过 SUN_LEN(104 bytes) 导致 EINVAL；
  // 2) git worktree / child process 返回 realpath 时会与软链路径产生前缀不一致。
  if (process.platform === "darwin" && existsSync("/tmp")) {
    env.TMPDIR = realpathSync("/tmp");
  }

  return env;
}

function readFilesFromManifest(mode, manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !parsed ||
      parsed.mode !== mode ||
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file) => typeof file === "string")
    ) {
      throw new Error("invalid manifest shape");
    }
    return parsed.files;
  } finally {
    rmSync(manifestPath, { force: true });
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (rest[0] === "--files-manifest") {
    const manifestPath = rest[1];
    if (!manifestPath) {
      throw new Error("--files-manifest requires a path");
    }
    return {
      mode,
      files: readFilesFromManifest(mode, manifestPath),
    };
  }

  return { mode, files: rest };
}

const { mode, files } = parseArgs(process.argv.slice(2));

if (mode !== "run" && mode !== "related" && mode !== "run-all") {
  console.error(
    "Usage: node scripts/run-lint-staged-vitest.mjs <run|related|run-all> [--files-manifest <path>|<files...>]",
  );
  process.exit(1);
}

if (files.length === 0 && mode !== "run-all") {
  process.exit(0);
}

const nativeTests =
  mode === "run" ? files.filter((file) => isNodeTestFile(file)) : discoverNodeUnitTests();
const vitestFiles = mode === "run" ? files.filter((file) => !isNodeTestFile(file)) : files;
const vitestArgs =
  mode !== "related"
    ? ["exec", "vitest", "run", "--exclude", ROOT_UNIT_E2E_GLOB, ...vitestFiles]
    : [
        "exec",
        "vitest",
        "related",
        "--run",
        "--passWithNoTests",
        "--exclude",
        ROOT_UNIT_E2E_GLOB,
        ...files,
      ];

const options = { env: createCleanGitEnv(), stdio: "inherit" };
if (nativeTests.length > 0) {
  const nativeResult = spawnPnpm(
    [
      "exec",
      "tsx",
      "--tsconfig",
      "packages/ui/tsconfig.json",
      "--test",
      "--test-concurrency=4",
      ...nativeTests,
    ],
    options,
  );
  if (nativeResult.error) console.error(nativeResult.error.message);
  if (nativeResult.status !== 0) process.exit(nativeResult.status ?? 1);
}
if (mode === "run" && vitestFiles.length === 0) process.exit(0);
const result = spawnPnpm(vitestArgs, options);

if (result.error) {
  console.error(`[lint-staged vitest] failed to spawn pnpm: ${result.error.message}`);
}

process.exitCode = result.status ?? 1;
