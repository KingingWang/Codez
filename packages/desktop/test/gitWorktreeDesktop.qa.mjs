import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

// 复用真实桌面隔离 probe；测试不访问用户 HOME，不连接外部模型，不碰用户仓库。
const repoRoot = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);
const qaRoot = await mkdtemp(join(tmpdir(), "codez-worktree-qa-"));
const children = [];
let probeHome;
let failureOutput = "";

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

function launch(command, args, env, onLine = () => {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    failureOutput += `${error.message}\n`;
  });
  children.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop();
    for (const line of lines) onLine(line);
    failureOutput = (failureOutput + chunk.toString()).slice(-12_000);
  });
  child.stderr.on("data", (chunk) => {
    failureOutput = (failureOutput + chunk.toString()).slice(-12_000);
  });
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`QA process exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // 只等待本次隔离实例就绪，连接失败不改变任何产品状态。
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 250));
  }
  throw new Error(`QA readiness timed out: ${url}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return;
  }
  const timeout = AbortSignal.timeout(5000);
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => timeout.addEventListener("abort", resolveTimeout)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, "SIGKILL");
    await exited;
  }
}

async function configureIsolatedLocale(cdp) {
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const page = browser.contexts()[0].pages()[0];
    await page.getByTestId("task-new-button").waitFor();
    const registryUrl = `/@fs${repoRoot}/packages/ui/src/store/remoteWorkspaceSessionStore.ts`;
    const settingService = await page.waitForFunction(async (url) => {
      const registry = await import(url);
      return registry.getRegisteredBaseWorkspaceServices()?.settingService ?? null;
    }, registryUrl);
    await settingService.evaluate(async (service) => {
      // 隔离 HOME 默认跟随英文系统；中文用例显式固定偏好，不修改产品默认值。
      localStorage.setItem("codez-locale-preference", "zh-CN");
      await service.update({
        locale: "zh-CN",
        localePreference: "zh-CN",
      });
    });
    await settingService.dispose();
  } finally {
    await browser.close();
  }
}

try {
  const project = join(qaRoot, "project");
  await mkdir(project);
  await writeFile(join(project, "tracked.txt"), "base\n");
  await writeFile(join(project, ".gitignore"), ".env\n");
  await writeFile(join(project, ".env"), "QA_ONLY=true\n");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Codez QA"],
    ["config", "user.email", "qa@example.invalid"],
    ["add", "tracked.txt", ".gitignore"],
    ["commit", "-m", "QA fixture"],
  ])
    await run("git", args, { cwd: project });

  const rendererPort = await freePort();
  const cdpPort = await freePort();
  const vite = launch(
    "pnpm",
    [
      "--filter",
      "@codez/desktop",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(rendererPort),
      "--strictPort",
    ],
    {
      ...process.env,
      CODEZ_DESKTOP_RUNTIME: "codex",
      CODEZ_ENV: "production",
      VITE_CODEZ_E2E_STORE_BRIDGE: "1",
    },
  );
  await waitFor(`http://127.0.0.1:${rendererPort}`, vite);
  const probe = launch(
    process.execPath,
    ["packages/ui/src/settings/codex/qa/desktop-probe.mjs"],
    {
      ...process.env,
      CODEX_UI_QA_RENDERER_PORT: String(rendererPort),
      CODEX_UI_QA_CDP_PORT: String(cdpPort),
    },
    (line) => {
      if (!line.startsWith('{"isolated":')) return;
      probeHome = JSON.parse(line).isolated;
    },
  );
  await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, probe);
  await configureIsolatedLocale(`http://127.0.0.1:${cdpPort}`);
  const tests = launch(
    process.execPath,
    ["--test", "packages/desktop/test/gitWorktreeDesktop.e2e.test.mjs"],
    {
      ...process.env,
      CODEZ_WORKTREE_QA_ROOT: qaRoot,
      CODEZ_WORKTREE_QA_CDP: `http://127.0.0.1:${cdpPort}`,
    },
    (line) => process.stdout.write(`${line}\n`),
  );
  const code = await new Promise((resolveExit) => tests.once("exit", resolveExit));
  if (code !== 0) throw new Error(`Desktop E2E failed (${code})`);
} catch (error) {
  process.stderr.write(`${failureOutput}\n${error.stack}\n`);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  // 只清理本次 mkdtemp 创建的夹具和 probe 输出的隔离 profile。
  await rm(qaRoot, { recursive: true, force: true });
  if (probeHome?.startsWith(join(tmpdir(), "codex-ui-qa-"))) {
    await rm(probeHome, { recursive: true, force: true });
  }
}
