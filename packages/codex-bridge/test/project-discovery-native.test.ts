import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCodexProcess } from "../src/codex-process.js";
import type { CodexProcess } from "../src/contract.js";
import { sameExecutionPath } from "../src/execution-path.js";
import { ThreadStateStore } from "../src/thread-state.js";

interface NativeThread {
  id: string;
  cwd: string;
  modelProvider: string | null;
}

function sseResponse(text: string): string {
  const item = {
    type: "message",
    id: "msg-native",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const completed = {
    id: "resp-native",
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function childEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
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
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function execPinnedCodex(options: {
  t: TestContext;
  cwd: string;
  codexHome: string;
  prompt: string;
  reply: string;
}): Promise<string> {
  const abort = new AbortController();
  const abortTest = () => abort.abort();
  options.t.signal.addEventListener("abort", abortTest, { once: true });
  let stdout = "";
  let stderr = "";
  let exitCode: number | null;
  const child = spawn(
    process.env.CODEX_AUXILIARY_TEST_BINARY!,
    ["exec", "--skip-git-repo-check", "--json", options.prompt],
    {
      cwd: options.cwd,
      env: childEnv(options.codexHome),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      signal: abort.signal,
    },
  );
  try {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    [exitCode] = (await once(child, "close")) as [number | null];
  } finally {
    options.t.signal.removeEventListener("abort", abortTest);
  }
  assert.equal(exitCode, 0, stderr || stdout);
  const started = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.type === "thread.started" && typeof event.thread_id === "string");
  assert.ok(started, `CLI did not report thread.started: ${stdout}`);
  assert.ok(stdout.includes(options.reply), stdout);
  return started.thread_id as string;
}

async function startTurnAndWaitForCompletion(
  rpc: CodexProcess,
  threadId: string,
  input: { text: string }[],
): Promise<unknown> {
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const unsubscribe = rpc.onNotification((event) => {
    if (event.method !== "turn/completed") return;
    const params = event.params as { threadId?: string; turn?: { status?: string } };
    if (params.threadId === threadId && params.turn?.status === "completed") resolveCompleted();
  });
  const timeout = setTimeout(
    () => rejectCompleted(new Error("Native turn did not complete")),
    15_000,
  );
  try {
    const response = await rpc.request("turn/start", {
      threadId,
      input: input.map((part) => ({ type: "text", text: part.text, text_elements: [] })),
    });
    await completed;
    return response;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
}

test(
  "pinned native project discovery includes external exec and desktop threads and resumes external history",
  {
    skip: !process.env.CODEX_AUXILIARY_TEST_BINARY,
    timeout: 60_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "zcode-discovery-native-"));
    const physicalCwd = join(temporary, "workspace");
    // macOS 的 /var/folders 与 Windows 8.3 短名临时目录都是别名拼写；用符号链接/junction
    // 让每个平台都复现“Host 传别名、原生落盘物理路径”的真实生产场景。
    const cwd = join(temporary, "workspace-alias");
    const foreignCwd = join(temporary, "foreign-workspace");
    const codexHome = join(temporary, "codex-home");
    let rpc: CodexProcess | undefined;
    await mkdir(physicalCwd);
    await mkdir(foreignCwd);
    await mkdir(codexHome);
    await symlink(physicalCwd, cwd, process.platform === "win32" ? "junction" : "dir");
    t.after(async () => {
      // Windows 不允许移除仍由 app-server 打开的 SQLite 文件；先关闭进程再清理目录。
      await rpc?.close();
      await rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });

    let modelRequests = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        modelRequests++;
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
          input?: { content?: string }[];
        };
        const userText = payload.input
          ?.map((item) => item.content ?? "")
          .join("\n")
          .includes("Reply with desktop");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sseResponse(userText ? "desktop-created" : "external-created"));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "fixture"',
        'model = "fixture-model"',
        "[model_providers.fixture]",
        'name = "Isolated fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "[model_providers.cross-provider]",
        'name = "Isolated second provider"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "[analytics]",
        "enabled = false",
      ].join("\n"),
    );

    const externalThreadId = await execPinnedCodex({
      t,
      cwd,
      codexHome,
      prompt: "Reply with external.",
      reply: "external-created",
    });
    const foreignThreadId = await execPinnedCodex({
      t,
      cwd: foreignCwd,
      codexHome,
      prompt: "Reply with foreign.",
      reply: "external-created",
    });

    rpc = createCodexProcess({
      executable: process.env.CODEX_AUXILIARY_TEST_BINARY!,
      cwd,
      env: childEnv(codexHome),
      requestTimeoutMs: 20_000,
    });
    await rpc.initialize();
    const store = new ThreadStateStore(rpc, cwd);

    const desktopStarted = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      historyMode: "paginated",
      model: "cross-provider-model",
      modelProvider: "cross-provider",
    });
    const desktopTurn = await startTurnAndWaitForCompletion(rpc, desktopStarted.thread.id, [
      { text: "Reply with desktop." },
    ]);
    assert.ok(desktopTurn);

    const discovered = (await store.list()) as NativeThread[];
    const ids = discovered.map((thread) => thread.id);
    assert.ok(ids.includes(externalThreadId));
    assert.ok(ids.includes(desktopStarted.thread.id));
    assert.ok(!ids.includes(foreignThreadId));
    assert.equal(new Set(ids).size, ids.length);
    const external = discovered.find((thread) => thread.id === externalThreadId);
    const desktop = discovered.find((thread) => thread.id === desktopStarted.thread.id);
    assert.ok(external);
    assert.equal(external.modelProvider, "fixture");
    assert.ok(desktop);
    assert.equal(desktop.modelProvider, "cross-provider");

    const resumed = await store.ensure(externalThreadId);
    // 原生回传物理路径；归属按物理目录判断，不要求与别名拼写字符串相等。
    assert.equal(await sameExecutionPath(resumed.thread.cwd, physicalCwd), true);
    assert.equal(await sameExecutionPath(resumed.thread.cwd, foreignCwd), false);
    assert.equal((resumed.thread.turns as unknown[]).length, 1);
    const resumedTurn = await startTurnAndWaitForCompletion(rpc, externalThreadId, [
      { text: "Reply with desktop." },
    ]);
    assert.ok(resumedTurn);
    assert.equal(modelRequests, 4, "external, foreign, desktop, and resumed turns");
    const reloaded = await store.reloadAfterHistoryChange(externalThreadId);
    assert.equal((reloaded.thread.turns as unknown[]).length, 2);
  },
);
