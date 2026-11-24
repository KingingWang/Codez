import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const adapterSource = fileURLToPath(
  new URL("../src/exec/node-execution-adapter.ts", import.meta.url),
);

// 不能在 Vitest worker 内验证保活：框架的 IPC/定时器会掩盖 Node 在 close 尚未完成时退出。
const driverSource = `
import { NodeExecutionAdapter } from ${JSON.stringify(adapterSource)};
import { spawn } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function main() {
  const mode = process.argv[2], root = process.argv[3];
  const ready = join(root, 'worker.pid');
  if (mode === 'worker') {
    process.on('SIGTERM', () => {});
    await writeFile(ready, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'root') {
    spawn(process.execPath, [process.argv[1], 'worker', root], { stdio: ['ignore', 1, 2] });
    process.stdout.write('root output');
    setInterval(() => {}, 1000);
    return;
  }
  const adapter = new NodeExecutionAdapter({ outputRootDir: root, ...(mode === 'crash' ? { bashOutputTempDir: root } : {}) });
  const controller = new AbortController();
  const request = {
    command: {
      mode: 'shell', shellProfile: 'posix-bash',
      shellOverride: { path: '/bin/bash', dialect: 'posix', source: 'user-config', display: { name: 'bash' } },
      command: '"$TEST_NODE" "$TEST_DRIVER" root "$TEST_ROOT"',
    },
    cwd: root,
    // 修复原因：timeout 档原来只给 2000ms，而这段时间里 worker 还要完成
    // 「spawn bash + 冷启动 node + 写出 ready 文件」。本机实测该启动空载约 1.3s，
    // 全量套件并行时可达数秒，于是 root 进程组在 worker 写出 ready 前就被超时清掉，
    // 驱动只能报 'Worker did not start'（表现为 timeout/close 档随机红，单独跑又通过）。
    // 放宽到 8000ms：仍远小于外层 it.each 的 20s 上限，且 timed_out 语义不变。
    timeoutMs: mode === 'timeout' ? 8000 : 10000,
    env: { set: { TEST_NODE: process.execPath, TEST_DRIVER: process.argv[1], TEST_ROOT: root } },
    outputLimit: { persistOutput: 'always', ...(mode === 'output_limit' ? { maxPersistedBytes: 1 } : {}) },
  };
  const options = { signal: controller.signal, onEvent: (event) => {
    if (event.type === 'started') console.log('ROOT_PID ' + event.pid);
  } };
  const pending = mode === 'background' || mode === 'crash'
    ? adapter.runBashWithBackgroundLifecycle(request, { mode: 'explicit' }, options)
    : adapter.run(request, options);
  const background = mode === 'background' || mode === 'crash' ? await pending : undefined;
  if (background) console.log('ROOT_PID ' + background.task.pid);
  // 修复原因：这里等的是「真实 spawn bash + 冷启动 node 的 worker 写出 ready 文件」。
  // 全量套件并行时（214 个文件、forks pool）本机实测该启动可超过 5s，于是驱动进程以
  // exit code 1 报 'Worker did not start'，用例收到 code=1 而不是 0（单独跑通过，属负载敏感）。
  // 放宽到 15s，仍留在外层 it.each 的 20s 上限内，给后续 close/结算断言留出余量。
  const deadline = Date.now() + 15000;
  while (true) {
    try { await access(ready); break; } catch {}
    if (Date.now() >= deadline) throw new Error('Worker did not start');
    await sleep(20);
  }
  if (mode === 'crash') {
    console.log('OUTPUT_PATH ' + background.task.outputPath);
    await new Promise(() => {});
    return;
  }
  if (mode === 'abort') controller.abort();
  if (mode === 'background') await adapter.cancelBackgroundTask(background.task.taskId);
  // 后台 Stop 的 ACK 可早于最终 result；close 后再读取完整结算。
  if (mode === 'close' || mode === 'background') await adapter.close();
  const result = background
    ? (await adapter.waitForBackgroundTask(background.task.taskId)).result
    : await pending;
  console.log('RESULT ' + result.status);
  await adapter.close();
  console.log('CLOSE_FINISHED');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

async function isRunning(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    // Linux 容器的 init 可能延迟回收孤儿 zombie；已终止的进程不算仍在执行。
    return stdout.trim().length > 0 && !stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("Bash shutdown in an isolated Node", () => {
  let directory: string;
  let driver: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "codez-bash-shutdown-"));
    driver = join(directory, "driver.cjs");
    await build({
      stdin: { contents: driverSource, resolveDir: process.cwd() },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: driver,
      logLevel: "silent",
    });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps named tmp output when the host is killed without cleanup", async () => {
    const root = join(directory, "crash");
    await mkdir(root);
    const child = spawn(process.execPath, [driver, "crash", root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await vi.waitFor(() => expect(stdout).toContain("OUTPUT_PATH "), { timeout: 10_000 });
      const path = /OUTPUT_PATH ([^\r\n]+)/u.exec(stdout)![1]!;
      expect(path).toContain("codez-bash-");
      expect(await readFile(path, "utf8")).toBe("root output");
      child.kill("SIGKILL");
      await closed;
      expect(await readFile(path, "utf8")).toBe("root output");
    } finally {
      child.kill("SIGKILL");
      const pid = Number(/ROOT_PID (\d+)/u.exec(stdout)?.[1]);
      if (pid > 1) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* 清理测试子进程。 */
        }
      }
    }
  }, 15_000);

  it.each(["abort", "close", "background", "timeout", "output_limit"])(
    "finishes cleanup before process exit after %s",
    async (mode) => {
      const root = join(directory, mode);
      await mkdir(root);
      const child = spawn(process.execPath, [driver, mode, root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code, stderr).toBe(0);
        expect(stdout).toContain("CLOSE_FINISHED");
        expect(stdout).toContain(`RESULT ${mode === "timeout" ? "timed_out" : "cancelled"}`);
        const pid = Number(await readFile(join(root, "worker.pid"), "utf8"));
        await vi.waitFor(async () => expect(await isRunning(pid)).toBe(false));
      } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        const rootPid = Number(/ROOT_PID (\d+)/u.exec(stdout)?.[1]);
        if (rootPid > 1) {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            /* 测试负责回收失败时留下的进程组。 */
          }
        }
      }
    },
    20000,
  );
});
