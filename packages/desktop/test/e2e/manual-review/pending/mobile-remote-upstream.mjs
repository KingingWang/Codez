// MOBILE-UPSTREAM-01：未改动的上游手机页面 + 本项目 Main/Host 服务 + 真实 Codex。
// 仅在浏览器测试环境中将 WS 接到本地透传 fixture，不修改或注册线上 relay。
// 运行：pnpm exec tsx packages/desktop/test/e2e/manual-review/pending/mobile-remote-upstream.mjs
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { createMobileRemoteRelayFixture } from "../../helpers/mobile-remote-relay-fixture.mjs";
import { ChannelServer, Emitter, VSBuffer } from "@codez/rpc";
import {
  ICodezAgentService,
  ICodezTaskService,
  IWindowControllerService,
  IModelSelectionService,
  createCodezAgentConnectionScope,
} from "@codez/services";
import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  setDataBaseDir,
} from "@codez/services/node";
import { createWebRemoteControlFeatureGate } from "../../../../src/main/webRemoteControlFeatureGate.js";
import { createWindowHostControllerRuntime } from "../../../../src/host/windowHostControllerService.js";
import { scopeModelSelectionServiceForAttachment } from "../../../../src/host/modelSelectionAttachmentScope.js";
import { buildCodexBridge } from "../../../../../../scripts/build-codex-bridge.mjs";
import { stageCodexBinary } from "../../../../../../scripts/codex-runtime.mjs";
import { createSmokeModelServer } from "../../../../../../scripts/codex-bridge-smoke-fixture.mjs";

// 与 Vitest 使用相同的 telemetry stub；Node-only Host fixture 不加载 Electron 的 ARMS 插件。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron")
      return {
        url: "data:text/javascript,export const app = undefined;",
        shortCircuit: true,
      };
    if (specifier === "@arms/rum-electron")
      return {
        url: new URL("../../../mocks/armsRumElectronStub.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { createWebRemoteControlManager } =
  await import("../../../../src/main/webRemoteControlManager.js");

const root = await mkdtemp(join(tmpdir(), "mobile-upstream-"));
const workspace = join(root, "workspace");
const nativeHome = join(root, "native-home");
const artifacts = resolve(".tmp/mobile-remote-upstream-e2e");
await Promise.all([mkdir(workspace), mkdir(nativeHome), mkdir(artifacts, { recursive: true })]);
const modelBodies = [];
const { server: modelServer } = createSmokeModelServer({
  onRequest: (body) => modelBodies.push(body),
});
let holdResponses = false;
const pendingResponses = new Set();
// 测试屏障只延迟 fixture 的 SSE 完成，不用等待时长伪造 runtime 的 running/queue 状态。
modelServer.prependListener("request", (_request, response) => {
  if (!holdResponses) return;
  const end = response.end.bind(response);
  let complete;
  response.end = (...args) => {
    complete = () => {
      pendingResponses.delete(complete);
      end(...args);
    };
    pendingResponses.add(complete);
    return response;
  };
  response.on("close", () => pendingResponses.delete(complete));
});
modelServer.listen(0, "127.0.0.1");
await once(modelServer, "listening");
await writeFile(
  join(nativeHome, "config.toml"),
  [
    'model_provider = "smoke"',
    'model = "gpt-5.2"',
    'model_reasoning_effort = "high"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "[model_providers.smoke]",
    'name = "Isolated mobile test"',
    `base_url = "http://127.0.0.1:${modelServer.address().port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "[analytics]",
    "enabled = false",
    "",
  ].join("\n"),
);
process.env.CODEZ_DESKTOP_RUNTIME = "codex";
process.env.CODEZ_DESKTOP_HOME_DIR = root;
process.env.CODEZ_CODEX_BRIDGE_PATH = await buildCodexBridge();
process.env.CODEZ_CODEX_COMMAND = await stageCodexBinary();
setDataBaseDir(root);
const services = createLocalServices({
  codezBuiltinProviderConfigFilePath: resolve("config/provider/codez-builtin.test.json"),
  agentTelemetry: { runtimeSurface: "desktop_local_host" },
  runtimeProcessEnvPatch: { CODEX_HOME: nativeHome, CODEZ_CODEX_BRIDGE_HOME: join(root, "bridge") },
});
const agent = services.get(ICodezAgentService);
const tasks = services.get(ICodezTaskService);
const sourceScope = { kind: "local", workspacePath: workspace };
const controller = createWindowHostControllerRuntime({
  createId: randomUUID,
  resolveSource: () => ({
    scope: sourceScope,
    taskService: tasks,
    agentService: agent,
    sourceAvailability: "online",
  }),
});
services.register(IWindowControllerService, controller.service);
const { relay, wire, relayUrl } = await createMobileRemoteRelayFixture();
const attachments = new Map();
const rpcErrors = [];
const manager = createWebRemoteControlManager({
  relayWsUrl: relayUrl,
  mobileRemoteControlUrl: "https://zcode.z.ai/remote/v4",
  deviceMid: "local-mobile-test",
  deviceName: "Isolated Codez",
  appVersion: "3.15.1",
  authProvider: {
    createPassword: () => "synthetic",
    createPassHash: () => "synthetic-hash",
    calculateProof: () => "synthetic-proof",
  },
  authStorageProvider: {
    load: async () => undefined,
    save: async () => {},
    clear: async () => {},
    rotate: async () => {},
  },
  startupRestoreStorageProvider: {
    load: async () => undefined,
    save: async () => {},
    clear: async () => {},
  },
  featureGate: createWebRemoteControlFeatureGate(true),
  logger: {
    info() {},
    warn: (...args) => rpcErrors.push(args),
    error: (...args) => rpcErrors.push(args),
  },
  platformHandlers: {
    isDockerAvailable: async () => false,
    listWSLDistros: async () => [],
    listDockerContainers: async () => [],
    listSSHConfigAliases: async () => [],
    loadMcpFromUserDirectory: async () => ({ servers: [] }),
    saveMcpToUserDirectory: async () => ({ success: true }),
    migrateLegacyCommonMcp: async () => ({
      servers: {},
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
    }),
  },
  reconnectWorkspace: async () => {},
  attachWorkspaceHost: async () => {
    const id = randomUUID();
    const port = new EventEmitter();
    const input = new Emitter();
    port.postMessage = (bytes) => {
      if (bytes instanceof Uint8Array) input.fire(VSBuffer.wrap(bytes));
    };
    port.close = () => {};
    const scope = createCodezAgentConnectionScope(agent, {
      connectionId: id,
      clientMode: "web-remote-replayable",
    });
    const controllerScope = controller.createAttachmentService();
    let server;
    port.start = () => {
      server = new ChannelServer(
        {
          onMessage: input.event,
          send: (buffer) => queueMicrotask(() => port.emit("message", { data: buffer.buffer })),
        },
        "isolated-window-host",
        1000,
        false,
        "upstream",
      );
      services.exposeOnChannelServer(
        server,
        new Map([
          [ICodezAgentService.channelName, scope.service],
          [IWindowControllerService.channelName, controllerScope],
          [
            IModelSelectionService.channelName,
            scopeModelSelectionServiceForAttachment(
              services.get(IModelSelectionService),
              "web-remote-replayable",
              sourceScope,
            ),
          ],
        ]),
      );
    };
    attachments.set(id, async () => {
      server?.dispose();
      input.dispose();
      controllerScope.dispose();
      await scope.dispose();
    });
    return { entryId: "one-existing-host", attachmentId: id, process: {}, port };
  },
  releaseWorkspaceHostAttachment: (id) => {
    void attachments.get(id)?.();
    attachments.delete(id);
  },
  disposeWorkspaceHostAttachmentsForWindow: () => {},
  disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
});
let browser;
let page;
try {
  await tasks.initialize({ workspacePath: workspace });
  const start = await manager.start(1, { workspacePath: workspace });
  manager.syncAvailableWorkspaces(1, [{ ...sourceScope, label: "MOBILE-UPSTREAM-01" }]);
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (error) => rpcErrors.push(["pageerror", error.message]));
  page.on("console", (message) => {
    if (message.type() === "error") rpcErrors.push(["browser", message.text()]);
  });
  // 页面 JS/CSS 原样来自上游；只对测试浏览器的 WS 做路由，不改上游代码或真实 relay。
  await page.routeWebSocket("**/*", (route) => {
    const socket = new WebSocket(relayUrl);
    const queued = [];
    route.onMessage((message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else queued.push(message);
    });
    socket.on("open", () => {
      for (const message of queued) socket.send(message);
    });
    socket.on("message", (message) => route.send(message.toString()));
    socket.on("close", () => {
      void route.close();
    });
    route.onClose(() => socket.close());
  });
  await page.goto(start.qrUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="onboarding-page"]') ||
      document.body.innerText.includes("MOBILE-UPSTREAM-01"),
    { timeout: 30000 },
  );
  // 隔离 profile 的首次职业引导通过真实 UI 跳过，不伪造设置或任务状态。
  for (let step = 0; step < 3 && (await page.getByTestId("onboarding-page").isVisible()); step++) {
    await page.getByRole("button", { name: /^(跳过|Skip)$/ }).click();
  }
  await page.getByTestId("onboarding-page").waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("MOBILE-UPSTREAM-01"), {
    timeout: 30000,
  });
  await page.screenshot({ path: join(artifacts, "mobile-home.png") });
  await page
    .locator("button")
    .filter({ has: page.locator("svg.lucide-plus") })
    .click();
  const composer = page.getByTestId("v4-composer-input");
  await composer.waitFor({ timeout: 30000 });
  await composer.fill("E2E_MOBILE_UPSTREAM_INPUT");
  await page.getByTestId("v4-composer-send").click({ timeout: 15000 });
  await page.getByText("Bridge smoke response", { exact: true }).waitFor({ timeout: 30000 });
  assert.ok(
    modelBodies.some((body) => JSON.stringify(body.input).includes("E2E_MOBILE_UPSTREAM_INPUT")),
  );
  const [task] = await tasks.listTasks({ workspacePath: workspace });
  assert.ok(task?.taskId, "首发必须持久化到已有 Host 的 task service");
  // Main 在生产环境接收桌面投影；fixture 同样从真实持久层读取，不伪造手机任务。
  manager.syncAvailableTasks(1, [
    {
      ...task,
      workspaceLabel: "MOBILE-UPSTREAM-01",
      workspaceKind: "local",
    },
  ]);
  const requestsBeforeReload = modelBodies.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="v4-composer-input"]') ||
      document.querySelector('[data-testid^="task-item-"]'),
    { timeout: 30000 },
  );
  if (!(await composer.isVisible())) await page.getByTestId(`task-item-${task.taskId}`).click();
  await page.getByText("Bridge smoke response", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(modelBodies.length, requestsBeforeReload, "刷新恢复不能重新派发输入");
  await composer.fill("E2E_MOBILE_UPSTREAM_FOLLOWUP");
  await page.getByTestId("v4-composer-send").click();
  await page.getByText("Bridge smoke response", { exact: true }).nth(1).waitFor({ timeout: 30000 });
  assert.deepEqual(
    (await tasks.listTasks({ workspacePath: workspace })).map((item) => item.taskId),
    [task.taskId],
    "刷新和跟进应复用同一个 task，而不是启动第二个会话",
  );
  await page.screenshot({ path: join(artifacts, "mobile-reconnected.png") });

  holdResponses = true;
  await composer.fill("E2E_MOBILE_UPSTREAM_RUNNING");
  await page.getByTestId("v4-composer-send").click();
  await page.getByTestId("v4-stop").waitFor();
  await composer.fill("E2E_MOBILE_UPSTREAM_QUEUED");
  await page.getByTestId("v4-composer-send").click();
  const queued = page
    .locator('[data-testid^="v4-queue-item-"]')
    .filter({
      hasText: "E2E_MOBILE_UPSTREAM_QUEUED",
    })
    .first();
  await queued.waitFor();
  await composer.fill("E2E_MOBILE_UPSTREAM_FIFO_SECOND");
  await page.getByTestId("v4-composer-send").click();
  const secondQueued = page
    .locator('[data-testid^="v4-queue-item-"]')
    .filter({
      hasText: "E2E_MOBILE_UPSTREAM_FIFO_SECOND",
    })
    .first();
  await secondQueued.waitFor();
  await page.getByTestId("v4-stop").click();
  await page.getByTestId("v4-stop").waitFor({ state: "hidden" });
  await queued.waitFor();
  await secondQueued.waitFor();
  await page.screenshot({ path: join(artifacts, "mobile-stopped-queue.png") });
  holdResponses = false;
  for (const complete of pendingResponses) complete();
  await page.getByTestId("v4-queue-resume").click();
  await queued.waitFor({ state: "hidden", timeout: 30000 });
  await secondQueued.waitFor({ state: "hidden", timeout: 30000 });
  await page.getByText("Bridge smoke response", { exact: true }).nth(3).waitFor({ timeout: 30000 });
  assert.ok(
    modelBodies.some((body) => JSON.stringify(body.input).includes("E2E_MOBILE_UPSTREAM_QUEUED")),
    "继续后的队列输入必须进入同一 Codex",
  );
  const firstQueueRequest = modelBodies.findIndex((body) =>
    JSON.stringify(body.input).includes("E2E_MOBILE_UPSTREAM_QUEUED"),
  );
  const secondQueueRequest = modelBodies.findIndex((body) =>
    JSON.stringify(body.input).includes("E2E_MOBILE_UPSTREAM_FIFO_SECOND"),
  );
  assert.ok(secondQueueRequest > firstQueueRequest, "原生队列必须保持 FIFO");
  await page.screenshot({ path: join(artifacts, "mobile-current.png") });
  await writeFile(
    join(artifacts, "browser-evidence.json"),
    JSON.stringify(
      {
        cases: ["MOBILE-UPSTREAM-01", "MOBILE-UPSTREAM-02"],
        taskId: task.taskId,
        title: await page.title(),
        text: await page.locator("body").innerText(),
        wire,
        rpcErrors,
        modelRequests: modelBodies.length,
      },
      null,
      2,
    ),
  );
  assert.ok(wire.some((entry) => entry.type === "bootstrap-response"));
  assert.ok(wire.some((entry) => entry.type === "workspace-bridge-ready"));
  assert.equal(rpcErrors.length, 0);
  console.log("MOBILE-UPSTREAM-01/02 passed (create/send/reconnect/queue/stop/resume)");
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") });
  await writeFile(
    join(artifacts, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        text: page ? await page.locator("body").innerText() : "",
        wire,
        rpcErrors,
        modelRequests: modelBodies.length,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  await manager.stop(1);
  for (const dispose of attachments.values()) await dispose();
  controller.dispose();
  await disposeServiceResourcesAndWait(services);
  for (const socket of relay.clients) socket.terminate();
  await new Promise((resolveClose) => relay.close(resolveClose));
  await new Promise((resolveClose) => modelServer.close(resolveClose));
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
  hooks.deregister();
}
