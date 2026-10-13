import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_MODEL_PROVIDER_KEY_MODE_SELECT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  buildRemoteWorkspaceIdentity,
  testId,
  type RemoteTarget,
} from "@codez/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomOpenAIChatCompletionsProvider,
} from "../../../helpers/custom-openai-provider.js";
import { resolveSeededReplayBaseUrl } from "../../../helpers/custom-openai-provider-store.js";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import {
  clickLastEnabledSSHDialogButton,
  createSSHReplayTunnel,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type ReplayTunnel,
} from "../../../helpers/ssh-remote-p0.js";
import { sel } from "../../../helpers/selectors.js";
import { selectUpstreamProviderModelById } from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_ENVKEY_SSH";
const PROVIDER_ID = "e2e-envkey-ssh-provider";
const MODEL_ID = "e2e-envkey-ssh-model";
const PROMPT_MARKER = "E2E_ENVKEY_SSH_FIRST_PROMPT";
const REPLY_MARKER = "E2E_ENVKEY_SSH_FIRST_REPLY";

describe(`${CASE_MARKER}: 临时 Key 本地保存与 SSH 首发`, () => {
  let tunnel: ReplayTunnel | null = null;
  let authProxy: Server | null = null;

  after(async () => {
    await tunnel?.close();
    if (authProxy) {
      authProxy.closeAllConnections();
      await new Promise<void>((resolve) => authProxy!.close(() => resolve()));
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("ENVKEY-01/02 模式切换后只有引用远端落盘，真实请求用本机临时 Key", async function () {
    this.timeout(20 * 60_000);
    if (process.env.CODEZ_DESKTOP_RUNTIME !== "legacy") {
      throw new Error(`${CASE_MARKER}: 此用例需要 CODEZ_DESKTOP_RUNTIME=legacy`);
    }
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const target: RemoteTarget = {
      kind: "ssh",
      host: config.host,
      port: config.port,
      username: config.username,
    };
    const secret = `e2e-ephemeral-${randomUUID()}`;
    const replayBaseURL = await resolveSeededReplayBaseUrl();
    if (!replayBaseURL) throw new Error(`${CASE_MARKER}: replay provider URL 不可用`);

    let authorizedRequests = 0;
    let unauthorizedRequests = 0;
    authProxy = createServer((incoming, outgoing) => {
      if (incoming.headers.authorization !== `Bearer ${secret}`) {
        unauthorizedRequests += 1;
        outgoing.writeHead(401).end();
        return;
      }
      authorizedRequests += 1;
      const destination = new URL(incoming.url ?? "/", replayBaseURL);
      const upstream = request(
        destination,
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: destination.host },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(upstream);
    });
    const proxyPort = await new Promise<number>((resolve, reject) => {
      authProxy!.once("error", reject);
      authProxy!.listen(0, "127.0.0.1", () => {
        const address = authProxy!.address();
        if (!address || typeof address === "string") {
          reject(new Error(`${CASE_MARKER}: 本地鉴权代理未监听`));
        } else resolve(address.port);
      });
    });
    tunnel = await createSSHReplayTunnel(config, CASE_MARKER, `http://127.0.0.1:${proxyPort}`);

    await prepareV4ConversationE2E({ skipProvider: true });
    const previousBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL;
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = tunnel.baseURL;
    try {
      await seedCustomOpenAIChatCompletionsProvider({
        apiKey: secret,
        providerId: PROVIDER_ID,
        providerName: CASE_MARKER,
        modelId: MODEL_ID,
      });
      await refreshSeededOpenAIProvidersThroughSettings([CASE_MARKER]);
    } finally {
      if (previousBaseURL === undefined) delete process.env.E2E_PROVIDER_RUNTIME_BASE_URL;
      else process.env.E2E_PROVIDER_RUNTIME_BASE_URL = previousBaseURL;
    }

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${PROVIDER_ID}`));
    await clickTestIdByDom(TID_MODEL_PROVIDER_KEY_MODE_SELECT);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
            (element) => element.textContent?.includes("Temporary environment variable"),
          );
          item?.click();
          return Boolean(item);
        }),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有临时 Key 模式选项` },
    );
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    const paths = getE2EAppDataPaths();
    await browser.waitUntil(
      async () => {
        const text = await readFile(paths.configFile, "utf8");
        return text.includes("apiKeyEnv") && !text.includes(secret);
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 本机配置仍包含明文 Key` },
    );
    const localConfig = await readFile(paths.configFile, "utf8");
    expect(localConfig).not.toContain(secret);
    expect(localConfig).toContain("CODEZ_MODEL_API_KEY_");
    expect(await readFile(paths.credentialsFile, "utf8")).not.toContain(secret);
    const settingsText = await browser.execute(() => document.body.innerText);
    expect(settingsText).not.toContain(secret);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await startNewV4Draft();
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    await waitForWorkspaceApp(workspacePath, 2 * 60_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: buildRemoteWorkspaceIdentity(workspacePath, target),
      expectedPath: workspacePath,
    });

    await selectUpstreamProviderModelById(MODEL_ID, {
      includePlainModelFallback: false,
      providerId: PROVIDER_ID,
      providerName: CASE_MARKER,
    });
    await startNewV4Draft();
    const requestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${PROMPT_MARKER}: 只回复 ${REPLY_MARKER}`,
      PROMPT_MARKER,
      `${CASE_MARKER}: SSH 首发未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [PROMPT_MARKER] },
      `${CASE_MARKER}: 请求未到达 replay provider`,
      2 * 60_000,
      { afterIndex: requestStart - 1 },
    );
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 2 * 60_000);
    expect(authorizedRequests).toBeGreaterThan(0);
    expect(unauthorizedRequests).toBe(0);

    const remote = await runSSHCommand(
      config,
      'for file in "$HOME/.codez/v2/provider_config.json" "$HOME/.codez/v2/credentials.json" "$HOME/.codez/v2/runtime/provider/provisioning.json"; do if [ -f "$file" ]; then cat "$file"; fi; done',
    );
    expect(remote.code).toBe(0);
    expect(remote.stdout).toContain("CODEZ_MODEL_API_KEY_");
    expect(remote.stdout).not.toContain(secret);
  });
});
