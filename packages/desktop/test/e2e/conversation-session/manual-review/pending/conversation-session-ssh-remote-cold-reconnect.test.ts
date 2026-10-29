import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { parseRemoteWorkspaceIdentity } from "@codez/shared";
import { TID_TASK_ITEM, testId } from "@codez/shared/test-ids";
import { releaseControlledReplay } from "../../../helpers/controlled-replay.js";
import { clearAppData, readSettings, seedSettings } from "../../../helpers/desktop-app.js";
import { selectUpstreamProviderModelById } from "../../../helpers/upstream-provider.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readTaskRowInProject,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
  SSH_LIFECYCLE_MODEL_ID,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  prepareSSHConnectionPage,
  readHostProcesses,
  runSSHCommand,
  readRemoteTabSnapshot,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";

import {
  selectTaskOrganizeMode,
  openWorkspaceDraftFromSidebar,
} from "../../../helpers/workspace-agent-warmup.js";

import {
  getV4PaneSnapshot,
  selectV4TaskById,
  waitForV4ConversationState,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_SSH_P0_COLD_RECONNECT";

describe(`${CASE_MARKER}: SSH cold restart and automatic reconnect`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-LIFE-01 App 冷重启后连接原项目并进入草稿，手动打开原 task", async function () {
    this.timeout(35 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });
    const oldHosts = await readHostProcesses();
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    expect(sourceId).toBeTruthy();
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, {
      workspaceIdentities: [taskA.identity, taskB.identity],
    });
    const offlineA = $(`[data-project-workspace-identity="${taskA.identity}"]`);
    expect(await offlineA.isDisplayed()).toBe(true);
    expect(["offline", "failed"]).toContain(await offlineA.getAttribute("data-connection-state"));

    await requestRemoteProjectConnection(taskB.identity, CASE_MARKER);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
    });
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === taskB.taskId,
      `${CASE_MARKER}: 原地重连没有保留原会话`,
      60_000,
    );
    await waitForV4AssistantMessageContaining(taskB.firstReply);
    // #30：完整 App restart 时远端仍 running，不能用 renderer reload 或已完成历史代替。
    const runningPrompt = `${CASE_MARKER}_RUNNING_RESTART`;
    await sendV4Prompt(runningPrompt);
    await waitForV4TimelineContaining("SSH_COLD_RUNNING");
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskB.taskId && snapshot.canStop,
      `${CASE_MARKER}: restart 前原 task 没有 running`,
    );
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return (
          settings.lastWorkspaceSession?.[settings.lastActiveTabIndex ?? 0]?.workspacePath ===
          workspaceB
        );
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 原激活项目没有持久化` },
    );

    // browser.reloadSession 才会重启 Electron/Main/Host/CLI；renderer reload 不足以证明冷恢复。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const running = await runSSHCommand(
          prepared.config,
          '"$HOME/.codez/server/bin/codez" running-tasks --json',
        );
        expect(running.code).toBe(0);
        expect(running.stdout).toContain(taskB.taskId);
      },
    });
    await waitForRendererAfterColdRestart(CASE_MARKER);
    // 从首次点击前观察每次 toast DOM 变动，最终截图不能证明没有瞬时错误。
    await browser.execute(() => {
      const observed = { messages: [] as string[], observer: null as MutationObserver | null };
      const capture = () => {
        const text = document.getElementById("codez-toast-host")?.textContent?.trim();
        if (text) observed.messages.push(text);
      };
      observed.observer = new MutationObserver(capture);
      observed.observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      (window as unknown as { __issue30Toasts: typeof observed }).__issue30Toasts = observed;
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (taskId) => {
            const row = document.querySelector<HTMLElement>(`[data-testid="${taskId}"]`);
            if (!row) return false;
            row.click();
            row.click();
            row.click();
            return true;
          },
          testId(TID_TASK_ITEM, taskB.taskId),
        ),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: cold restart 原 task 行未恢复` },
    );
    // F5：冷启动自动恢复最后活动的 B；A 保留项目入口，稍后按需打开。
    const reconnectedB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      requireActive: false,
    });
    expect((await readRemoteTabSnapshot(taskA.identity)).secretPersistedInTab).toBe(false);
    expect((await readRemoteTabSnapshot(taskB.identity)).secretPersistedInTab).toBe(false);
    expect(reconnectedB.remoteSessionId).not.toBe(taskB.remoteSessionId);
    expect(await readHostProcesses()).toHaveLength(1);

    // 旧用例混淆冷启动与原地重连；冷启动保留项目，但必须由用户显式选择历史任务。
    expect((await readRemoteTabSnapshot(taskB.identity)).activeWorkspaceIdentity).toBe(
      taskB.identity,
    );
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      `${CASE_MARKER}: 冷启动没有进入 B 项目草稿`,
      60_000,
    );
    await selectV4TaskById(taskB.taskId, 60_000);
    await waitForV4AssistantMessageContaining(taskB.firstReply);

    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBeNull();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskB.taskId && snapshot.canStop,
      `${CASE_MARKER}: restart 后原 running task 未恢复`,
    );
    const toasts = await browser.execute(() => {
      const observed = (
        window as unknown as {
          __issue30Toasts: { messages: string[]; observer: MutationObserver };
        }
      ).__issue30Toasts;
      observed.observer.disconnect();
      return observed.messages;
    });
    expect(
      toasts.filter((text) =>
        /project\.navigation-cancelled|remote-bind-canceled|尚无可用 renderer attachment|打开任务失败/.test(
          text,
        ),
      ),
    ).toEqual([]);
    await releaseControlledReplay("ssh-cold-running");
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === taskB.taskId && snapshot.state === "idle",
      `${CASE_MARKER}: 释放流后原 task 没有完成`,
    );
    await openWorkspaceDraftFromSidebar(workspaceA);
    const reconnectedA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
    });
    expect(reconnectedA.remoteSessionId).not.toBe(taskA.remoteSessionId);
    expect(reconnectedA.remoteSessionId).not.toBe(reconnectedB.remoteSessionId);

    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    const resumedA: SSHLifecycleTask = {
      ...taskA,
      remoteSessionId: reconnectedA.remoteSessionId!,
    };
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await sendSSHFollowTurn(resumedA, CASE_MARKER, taskB.firstPrompt);
    const resumedB: SSHLifecycleTask = {
      ...taskB,
      remoteSessionId: reconnectedB.remoteSessionId!,
    };
    await readTaskRowInProject(resumedB, CASE_MARKER);
    await sendSSHFollowTurn(resumedB, CASE_MARKER, taskA.firstPrompt);
    expect(await readHostProcesses()).not.toEqual(oldHosts);

    await seedSettings({ remoteStartupAutoReconnectEnabled: false });
    await disconnectRemoteSource(sourceId!, CASE_MARKER);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(CASE_MARKER);
    const unavailable = $('[data-testid="remote-conversation-unavailable"]');
    await unavailable.waitForDisplayed({ timeout: 30_000 });
    expect((await readRemoteTabSnapshot(taskB.identity)).activeWorkspaceIdentity).toBe(
      taskB.identity,
    );
    expect(await getV4PaneSnapshot()).toMatchObject({ sessionId: null, rowCount: 0 });
    expect(await $('[data-testid="remote-conversation-banner"]').isDisplayed()).toBe(true);
    await browser.saveScreenshot(`${process.env.CODEZ_E2E_ARTIFACT_DIR}/rdux09-cold-offline.png`);

    await requestRemoteProjectConnection(taskB.identity, CASE_MARKER);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
    });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      `${CASE_MARKER}: 未连接启动后挂回没有保持项目草稿`,
      60_000,
    );
    await selectV4TaskById(taskB.taskId, 60_000);
    await waitForV4AssistantMessageContaining(taskB.firstReply);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === taskB.taskId,
      `${CASE_MARKER}: 手动打开原任务后身份不一致`,
    );
  });
});
