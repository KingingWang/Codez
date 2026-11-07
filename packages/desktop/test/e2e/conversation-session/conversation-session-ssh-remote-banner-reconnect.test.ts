import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "../helpers/ssh-remote-lifecycle.js";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  type SSHConnectionConfig,
} from "../helpers/ssh-remote-p0.js";
import { waitForV4ConversationState } from "../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_SSH_BANNER_RECONNECT";
const artifactDir = resolve(
  process.env.CODEZ_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-banner-reconnect",
);
const BANNER = '[data-testid="remote-conversation-banner"]';
const WIZARD = '[data-testid="ssh-dialog"]';

type ProxyMode = "forward" | "reset" | "close";

interface ResettingSSHProxy {
  port: number;
  rejectedConnections(): number;
  /**
   * forward：透传到真实 sshd；reset：现有连接发 RST，新连接收到客户端数据后发 RST；
   * close：对现有与新连接正常关闭（FIN），握手前断开且不带系统错误码。
   */
  setMode(mode: ProxyMode): void;
  close(): Promise<void>;
}

/**
 * 本机 loopback TCP 代理：Desktop 连代理端口，代理再连容器 sshd。
 * 验证报告里的故障注入是“切断代理并拒绝后续连接”，Host 看到的是 `read ECONNRESET`；
 * 这里用 resetAndDestroy 复现同一错误形状，不杀远端 sshd，远端任务与回放隧道都保持存活。
 */
async function createResettingSSHProxy(
  config: Pick<SSHConnectionConfig, "host" | "port">,
): Promise<ResettingSSHProxy> {
  let mode: ProxyMode = "forward";
  let rejectedConnections = 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server: Server = createServer((client) => {
    track(client);
    if (mode === "reset") {
      // 接受后立即重置会与 SSH 首写竞争，产生 EPIPE；收到客户端标识后再复现读侧 ECONNRESET。
      client.once("data", () => {
        rejectedConnections += 1;
        client.resetAndDestroy();
      });
      return;
    }
    if (mode === "close") {
      rejectedConnections += 1;
      client.end();
      return;
    }
    const upstream = createConnection({ host: config.host, port: config.port });
    track(upstream);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`${CASE_MARKER}: 代理没有拿到端口`));
        return;
      }
      resolvePort(address.port);
    });
  });
  return {
    port,
    rejectedConnections: () => rejectedConnections,
    setMode(next) {
      mode = next;
      if (next === "reset") for (const socket of sockets) socket.resetAndDestroy();
      if (next === "close") for (const socket of sockets) socket.end();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function waitForOfflineProbe(
  proxy: ResettingSSHProxy,
  expectedRejectedConnections: number,
): Promise<{ state: string | null; text: string }> {
  await browser
    .waitUntil(async () => proxy.rejectedConnections() >= expectedRejectedConnections, {
      interval: 250,
      timeout: 180_000,
      timeoutMsg: "offline-probe-not-reached",
    })
    .catch((error: unknown) => {
      throw new Error(`${CASE_MARKER}: 三次快速重试没有全部被代理拒绝`, { cause: error });
    });
  // 第三次 RST/FIN 后给 Host 一个事件循环窗口发布 offline probe；随后必须仍是 recovering。
  await browser.pause(1000);
  const banner = await readBannerText();
  expect(banner.state).toBe("connecting");
  expect(banner.text).toMatch(/3\s*\/\s*3/u);
  return banner;
}

async function readBannerText(): Promise<{ state: string | null; text: string }> {
  return browser.execute((selector) => {
    const banner = document.querySelector<HTMLElement>(selector);
    return {
      state: banner?.getAttribute("data-connection-state") ?? null,
      text: (banner?.innerText ?? "").replace(/\s+/gu, " ").trim(),
    };
  }, BANNER);
}

async function waitForAutomaticSessionRestore(options: {
  taskId: string;
  identity: string;
  previousRemoteSessionId: string;
}): Promise<string> {
  let restored = await readRemoteTabSnapshot(options.identity);
  await browser.waitUntil(
    async () => {
      restored = await readRemoteTabSnapshot(options.identity);
      return (
        Boolean(restored.remoteSessionId) &&
        restored.remoteSessionId !== options.previousRemoteSessionId
      );
    },
    {
      interval: 1000,
      timeout: 180_000,
      timeoutMsg: `${CASE_MARKER}: 离线探测没有自动换代远端 workspace`,
    },
  );
  if (!restored.remoteSessionId) {
    throw new Error(`${CASE_MARKER}: 自动恢复后缺少 remoteSessionId`);
  }
  expect(await $(WIZARD).isExisting()).toBe(false);
  await waitForV4ConversationState(
    (snapshot) => snapshot.taskId === options.taskId,
    `${CASE_MARKER}: 自动恢复后没有回到原会话`,
    60_000,
  );
  expect(await readBannerText()).toMatchObject({ state: null });
  return restored.remoteSessionId;
}

describe(`${CASE_MARKER}: 快速恢复预算耗尽后的离线探测自动恢复`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let proxy: ResettingSSHProxy | null = null;
  let reconnectedTaskId: string | null = null;
  let activeRemoteSessionId: string | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "banner-reconnect.json"), JSON.stringify(facts, null, 2));
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-09-offline-probe-reset ECONNRESET 耗尽快速预算后，恢复链路无需手动重连即可回到原会话", async function () {
    this.timeout(20 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    proxy = await createResettingSSHProxy(prepared.config);
    const config: SSHConnectionConfig = { ...prepared.config, port: proxy.port };

    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    facts.task = { taskId: task.taskId, identity: task.identity, session: task.remoteSessionId };

    // 故障：对端重置所有 SSH 连接，在线恢复 2/4/8s 三次重试同样被 RST。
    // 快速预算耗尽只切换到 2 分钟离线探测，不能关闭原 logical session。
    const rejectedBeforeFailure = proxy.rejectedConnections();
    proxy.setMode("reset");
    const banner = await waitForOfflineProbe(proxy, rejectedBeforeFailure + 3);
    facts.bannerAfterBudgetExhausted = banner;
    await browser
      .saveScreenshot(resolve(artifactDir, "budget-exhausted.png"))
      .catch(() => undefined);
    expect((await readRemoteTabSnapshot(task.identity)).remoteSessionId).toBe(task.remoteSessionId);

    // 不点击横幅、不打开向导；恢复链路后由既有离线探测自动挂回原任务。
    proxy.setMode("forward");
    activeRemoteSessionId = await waitForAutomaticSessionRestore({
      taskId: task.taskId,
      identity: task.identity,
      previousRemoteSessionId: task.remoteSessionId,
    });
    facts.restoredSession = activeRemoteSessionId;
    await browser.saveScreenshot(resolve(artifactDir, "reconnected.png")).catch(() => undefined);
    reconnectedTaskId = task.taskId;
  });

  it("RDUX-09-offline-probe-handshake-lost 握手前 FIN 同样由离线探测自动恢复", async function () {
    this.timeout(10 * 60_000);
    if (!proxy || !reconnectedTaskId || !activeRemoteSessionId) {
      throw new Error(`${CASE_MARKER}: 依赖上一条用例把原会话重连上线`);
    }
    // 故障：代理对现有与新连接都发 FIN，ssh2 报 Connection lost before handshake，不带 ECONNRESET。
    const previousRemoteSessionId = activeRemoteSessionId;
    const rejectedBeforeFailure = proxy.rejectedConnections();
    proxy.setMode("close");
    const banner = await waitForOfflineProbe(proxy, rejectedBeforeFailure + 3);
    facts.bannerAfterHandshakeLost = banner;
    await browser
      .saveScreenshot(resolve(artifactDir, "handshake-lost-exhausted.png"))
      .catch(() => undefined);
    expect(banner.text).not.toContain("不满足安装要求");
    expect(banner.text).not.toContain("环境检查失败");
    expect((await readRemoteTabSnapshot()).remoteSessionId).toBe(previousRemoteSessionId);
    proxy.setMode("forward");
    activeRemoteSessionId = await waitForAutomaticSessionRestore({
      taskId: reconnectedTaskId,
      identity: "",
      previousRemoteSessionId,
    });
  });
});
