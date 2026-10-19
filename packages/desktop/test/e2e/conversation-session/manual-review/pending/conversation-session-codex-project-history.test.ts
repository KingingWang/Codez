import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { TID_TASK_ITEM, testId } from "@codez/shared/test-ids";
import { selectNativeProjectDirectories } from "../../../helpers/project-sidebar.js";
import { waitForWorkspaceApp } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const marker = "E2E_CODEX_PROJECT_HISTORY";

function nativeResponse(): string {
  const item = {
    type: "message",
    id: "msg-history",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: `${marker}_REPLY`, annotations: [] }],
  };
  const completed = {
    id: "resp-history",
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

async function createExternalThread(binary: string, codexHome: string, cwd: string, name: string) {
  // 原因：Codex exec 会等待仍打开的 stdin；子进程必须明确关闭输入，才能完成会话落盘。
  const child = spawn(
    binary,
    ["exec", "--skip-git-repo-check", "--json", `${marker}_${name}: reply briefly.`],
    {
      cwd,
      env: {
        CODEX_HOME: codexHome,
        HOME: process.env.CODEZ_E2E_HOME_DIR,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    throw new Error(`isolated Codex exec ${name} exited ${code}/${signal}: ${stderr}\n${stdout}`);
  const started = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; thread_id?: string })
    .find((event) => event.type === "thread.started");
  if (!started?.thread_id || !stdout.includes(`${marker}_REPLY`))
    throw new Error(`isolated Codex CLI did not persist ${name}: ${stdout}`);
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

describe("Codex 单目录项目历史", () => {
  let fixture: Server | undefined;
  let directoryA: string;
  let directoryB: string;
  let threadA: string;
  let threadB: string;

  before(async function () {
    this.timeout(120_000);
    const home = process.env.CODEZ_E2E_HOME_DIR;
    const binary = process.env.CODEX_AUXILIARY_TEST_BINARY;
    // 本例写入原生 CODEX_HOME/config.toml；只允许专用隔离目录，不能覆盖开发者配置。
    if (!home || !basename(home).startsWith("codez-codex-history-") || !binary)
      throw new Error("dedicated codez-codex-history-* E2E HOME and pinned Codex binary required");
    directoryA = join(home, "CodezProject", ".codez-e2e", "codex-project-history", "A");
    directoryB = join(home, "CodezProject", ".codez-e2e", "codex-project-history", "B");
    const codexHome = join(home, ".codex");
    await Promise.all(
      [directoryA, directoryB, codexHome].map((path) => mkdir(path, { recursive: true })),
    );
    fixture = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // 消费完整请求后回放固定响应，不访问真实模型或用户凭据。
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(nativeResponse());
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
    threadA = await createExternalThread(binary, codexHome, directoryA, "A");
    threadB = await createExternalThread(binary, codexHome, directoryB, "B");
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    fixture?.closeAllConnections();
    if (fixture?.listening) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  });

  it("VP-CODEX-01：后建单目录项目发现并打开同 cwd 的外部 CLI 历史", async function () {
    this.timeout(120_000);
    await createSingleRootProject(`${marker}_A`, directoryA);
    const projectA = $(`[data-project-name="${marker}_A"]`);
    const rowA = projectA.$(`[data-testid="${testId(TID_TASK_ITEM, threadA)}"]`);
    await rowA.waitForDisplayed({ timeout: 45_000 });
    expect(await projectA.$(`[data-testid="${testId(TID_TASK_ITEM, threadB)}"]`).isExisting()).toBe(
      false,
    );

    await createSingleRootProject(`${marker}_B`, directoryB);
    const projectB = $(`[data-project-name="${marker}_B"]`);
    await projectB
      .$(`[data-testid="${testId(TID_TASK_ITEM, threadB)}"]`)
      .waitForDisplayed({ timeout: 45_000 });
    expect(await projectA.$(`[data-testid="${testId(TID_TASK_ITEM, threadB)}"]`).isExisting()).toBe(
      false,
    );
    expect(await projectB.$(`[data-testid="${testId(TID_TASK_ITEM, threadA)}"]`).isExisting()).toBe(
      false,
    );
    await browser.saveScreenshot(
      join(process.env.CODEZ_E2E_ARTIFACT_DIR!, "VP-CODEX-01-cli-history-projects.png"),
    );

    await rowA.click();
    await waitForWorkspaceApp(directoryA, 30_000);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)),
          threadA,
        ),
      { timeout: 30_000, timeoutMsg: "CLI thread did not open in the Codex conversation pane" },
    );
    await browser.refresh();
    // 冷刷新允许回到全局草稿；项目和 CLI 行必须仍可重新导航，而不是要求保留当前 tab。
    const restored = $(`[data-project-name="${marker}_A"]`);
    await restored.waitForDisplayed();
    const toggle = restored.$('[data-testid="virtual-project-toggle"]');
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const reopened = restored.$(`[data-testid="${testId(TID_TASK_ITEM, threadA)}"]`);
    await reopened.waitForDisplayed({ timeout: 30_000 });
    await reopened.click();
    await waitForWorkspaceApp(directoryA, 30_000);
  });
});
