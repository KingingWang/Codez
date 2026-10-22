import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  loadCodexManifest,
  resolveCodexTarget,
  selectCodexAsset,
  stageCodexBinary,
  verifyCodexPackage,
} from "./codex-runtime.mjs";

export async function smokeCodexRuntime() {
  const target = resolveCodexTarget();
  if (target.os !== process.platform || target.arch !== process.arch)
    throw new Error("Codex smoke must run natively for its matrix target");
  const binary = await stageCodexBinary({ target });
  await verifyCodexPackage({
    directory: dirname(dirname(binary)),
    target,
    asset: selectCodexAsset(await loadCodexManifest(), target),
  });
  const temporary = await mkdtemp(join(tmpdir(), "codez-codex-smoke-"));
  // 测试不继承 API key、账号 token 或用户的 Codex 配置，只传进程启动必需环境。
  const env = { CODEX_HOME: join(temporary, "config") };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  await mkdir(env.CODEX_HOME, { recursive: true });
  await writeFile(
    join(env.CODEX_HOME, "config.toml"),
    'model_provider = "distribution_smoke"\nmodel = "distribution-smoke"\n[model_providers.distribution_smoke]\nname = "Distribution smoke (offline)"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n',
  );
  let child;
  try {
    // 初始化主程序不会加载工具宿主；单独执行一次，验证其平台架构与权限均可用。
    const toolHost = spawn(
      join(
        dirname(binary),
        target.os === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host",
      ),
      ["--help"],
      { cwd: temporary, env, shell: false, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 },
    );
    toolHost.stderr.resume();
    const [hostCode] = await once(toolHost, "close");
    if (hostCode !== 0) throw new Error(`Codex tool host launch failed: ${hostCode}`);
    console.log("[codex-smoke] native tool host launched");
    const schemaDir = join(temporary, "schema");
    const generator = spawn(
      binary,
      ["app-server", "generate-ts", "--experimental", "--out", schemaDir],
      { cwd: temporary, env, shell: false, stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    );
    generator.stderr.resume();
    const [schemaCode] = await once(generator, "exit");
    if (schemaCode !== 0)
      throw new Error(`Codex experimental API generation failed: ${schemaCode}`);
    const requests = await readFile(join(schemaDir, "ClientRequest.ts"), "utf8");
    for (const method of ["add", "list", "update", "delete", "reorder", "start"]) {
      if (!requests.includes(`"thread/queue/${method}"`))
        throw new Error(`Pinned Codex experimental schema is missing thread/queue/${method}`);
    }
    const files = await readdir(schemaDir, { recursive: true });
    console.log(
      `[codex-smoke] experimental API available (${files.length} schema entries, native queue present)`,
    );
    child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd: temporary,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    // 尽早安装拒绝处理，避免启动失败在握手 Promise 建立前变成未处理拒绝。
    closed.catch(() => {});
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    const lines = createInterface({ input: child.stdout });
    await new Promise((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex initialize timed out")), 30_000);
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) =>
        fail(new Error(`Codex exited before initialize: ${code}; ${stderr}`)),
      );
      child.stdin.once("error", fail);
      lines.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id !== 1) return;
          if (response.error || !response.result) throw new Error("Codex initialize failed");
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          clearTimeout(timeout);
          accept();
        } catch (error) {
          fail(error);
        }
      });
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "codez_codex_distribution_smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } } })}\n`,
      );
    });
    child.stdin.end();
    const shutdown = setTimeout(() => child.kill(), 5_000);
    await closed.finally(() => clearTimeout(shutdown));
    lines.close();
    console.log("[codex-smoke] isolated initialize/initialized handshake passed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close").catch(() => {});
      child.kill();
      await stopped;
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await smokeCodexRuntime();
