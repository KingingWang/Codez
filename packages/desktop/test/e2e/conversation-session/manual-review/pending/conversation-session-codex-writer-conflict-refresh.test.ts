import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn as spawnPty } from "node-pty";
import { TID_TASK_ITEM, testId } from "@codez/shared/test-ids";
import { selectNativeProjectDirectories } from "../../../helpers/project-sidebar.js";
import { waitForWorkspaceApp } from "../../../helpers/desktop-app.js";
import {
  getV4ComposerText,
  getV4Messages,
  prepareV4ConversationE2E,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const marker = "E2E_CODEX_WRITER_REFRESH";
const seedReply = `${marker}_SEED_REPLY`;
const appendedPrompt = `${marker}_APPEND_PROMPT`;
const appendedReply = `${marker}_APPEND_REPLY`;

function nativeResponse(text: string): string {
  const item = {
    type: "message",
    id: `msg-${text}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const completed = {
    id: `resp-${text}`,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function codexEnv(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function createExternalThread(binary: string, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, ["exec", "--skip-git-repo-check", "--json", `${marker}_SEED`], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timeout);
  }
  if (code !== 0)
    throw new Error(`isolated Codex exec exited ${code}/${signal}: ${stderr}\n${stdout}`);
  const started = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; thread_id?: string })
    .find((event) => event.type === "thread.started");
  if (!started?.thread_id || !stdout.includes(seedReply))
    throw new Error(`isolated Codex CLI did not persist seed: ${stdout}`);
  return started.thread_id;
}

async function createSingleRootProject(name: string, path: string) {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(name);
  await selectNativeProjectDirectories([path]);
  await $('[data-testid="virtual-project-save"]').click();
  const trust = $('[data-testid="project-folder-trust-confirm"]');
  if (await trust.isExisting()) await trust.click();
  const project = $(`[data-project-name="${name}"]`);
  await project.waitForDisplayed();
  const toggle = project.$('[data-testid="virtual-project-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  return project;
}

describe("Codex 外部 writer 冲突显式刷新", () => {
  let fixture: Server | undefined;
  let binary: string;
  let workspace: string;
  let env: NodeJS.ProcessEnv;
  let threadId: string;

  before(async function () {
    this.timeout(120_000);
    const home = process.env.CODEZ_E2E_HOME_DIR;
    const pinnedBinary = process.env.CODEX_AUXILIARY_TEST_BINARY;
    // 原生 config 与历史只写入专用 E2E HOME，绝不覆盖开发者的 Codex 数据。
    if (!home || !basename(home).startsWith("codez-codex-conflict-") || !pinnedBinary)
      throw new Error("dedicated codez-codex-conflict-* E2E HOME and pinned Codex binary required");
    binary = pinnedBinary;
    workspace = join(home, "CodezProject", ".codez-e2e", "codex-writer-conflict");
    const codexHome = join(home, ".codex");
    env = codexEnv(home, codexHome);
    await Promise.all([workspace, codexHome].map((path) => mkdir(path, { recursive: true })));
    fixture = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const reply = body.includes(appendedPrompt) ? appendedReply : seedReply;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(nativeResponse(reply));
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("fixture address unavailable");
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "fixture"',
        'model = "fixture-model"',
        "[model_providers.fixture]",
        'name = "Isolated E2E fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "[analytics]",
        "enabled = false",
      ].join("\n"),
    );
    threadId = await createExternalThread(binary, workspace, env);
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    fixture?.closeAllConnections();
    if (fixture?.listening) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  });

  it("CWR01/02：TUI 持锁追加历史时主动重选刷新，退出后再次重选恢复可写", async function () {
    this.timeout(150_000);
    const project = await createSingleRootProject(marker, workspace);
    const task = project.$(`[data-testid="${testId(TID_TASK_ITEM, threadId)}"]`);
    await task.waitForDisplayed({ timeout: 45_000 });

    const terminal = spawnPty(binary, ["--no-daemon", "--no-alt-screen", "resume", threadId], {
      cwd: workspace,
      env,
      name: "xterm-256color",
      cols: 140,
      rows: 40,
      useConptyDll: process.platform === "win32",
    });
    let output = "";
    let exited = false;
    terminal.onData((data) => {
      output += data;
    });
    const done = new Promise<void>((resolve) =>
      terminal.onExit(() => {
        exited = true;
        resolve();
      }),
    );
    const rendered = () => stripVTControlCharacters(output);
    try {
      await browser.waitUntil(() => rendered().includes(seedReply) && !exited, {
        timeout: 30_000,
        timeoutMsg: "Codex TUI did not resume the seeded thread",
      });
      await task.click();
      await waitForWorkspaceApp(workspace, 30_000);
      const banner = $('[data-testid="v4-writer-conflict-banner"]');
      await banner.waitForDisplayed({ timeout: 30_000 });
      await waitForV4TimelineContaining(seedReply);
      expect(await getV4ComposerText()).toBeNull();

      // TUI 输入与 Enter 分开：确认本次粘贴已绘制，避免动画帧造成误提交。
      const before = rendered().length;
      terminal.write(`\x1b[200~${appendedPrompt}\x1b[201~`);
      await browser.waitUntil(() => rendered().slice(before).includes(appendedPrompt), {
        timeout: 10_000,
        timeoutMsg: "Codex TUI did not paint appended prompt",
      });
      terminal.write("\r");
      await browser.waitUntil(() => rendered().includes(appendedReply), {
        timeout: 30_000,
        timeoutMsg: "Codex TUI did not render appended reply",
      });
      expect(
        (await getV4Messages("assistant")).some((message) => message.text.includes(appendedReply)),
      ).toBe(false);

      await task.click();
      await waitForV4TimelineContaining(appendedReply);
      expect(
        (await getV4Messages("assistant")).filter((message) =>
          message.text.includes(appendedReply),
        ),
      ).toHaveLength(1);
      await banner.waitForDisplayed();
      expect(await getV4ComposerText()).toBeNull();

      terminal.kill();
      await done;
      await task.click();
      await banner.waitForDisplayed({ reverse: true, timeout: 30_000 });
      await browser.waitUntil(() => getV4ComposerText().then((text) => text !== null), {
        timeout: 30_000,
        timeoutMsg: "composer did not recover after external writer exit",
      });
      expect(
        (await getV4Messages("assistant")).filter((message) =>
          message.text.includes(appendedReply),
        ),
      ).toHaveLength(1);
    } finally {
      if (!exited) terminal.kill();
      await done;
    }
  });
});
