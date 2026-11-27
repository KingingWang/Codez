import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { Buffer } from "node:buffer";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@codez/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readTaskRowInProject,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  ensureSSHProjectDirectoryStep,
  openSSHRemoteDialog,
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_SSH_R3_EQUIVALENT_PATH";

/** R3-REMOTE-09C：等价路径形态收敛同一身份；首句后续句、冷启旧 task、归档落远端库。 */
describe(`${CASE_MARKER}: SSH 等价路径身份收敛与旧会话归档`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3-REMOTE-09C 尾斜杠重开收敛原 workspace，续句/冷启/归档不报 remote-project-required", async function () {
    this.timeout(30 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA: SSHLifecycleTask = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });

    // 以尾斜杠形态重开同一目录：身份归一后必须复用原 tab，且首次 bind 路径不被改写。
    await openSSHRemoteDialog(CASE_MARKER);
    await ensureSSHProjectDirectoryStep(prepared.config, CASE_MARKER);
    await selectSSHRemoteDirectory(`${workspaceA}/`, CASE_MARKER);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    const reopened = await readRemoteTabSnapshot(taskA.identity, workspaceA);
    expect(reopened.activeWorkspaceIdentity).toBe(taskA.identity);
    expect(reopened.activeWorkspacePath).toBe(workspaceA);

    // 修复前：等价路径重开覆盖 Core 映射后，本续句订阅报 project.remote-project-required。
    await sendSSHFollowTurn(taskA, CASE_MARKER);

    // 冷重启后旧 task 仍可读、可续发。
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(CASE_MARKER);
    await readTaskRowInProject(taskA, CASE_MARKER);
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForV4AssistantMessageContaining(taskA.firstReply, 60_000);
    await sendSSHFollowTurn(taskA, CASE_MARKER);

    // 归档写远端 tasks-index；修复前映射分叉会让归档报任务不存在。
    const item = $(`[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`);
    await item.waitForExist({ timeout: 30_000 });
    await item.moveTo();
    await browser.waitUntil(
      () =>
        browser.execute(
          (itemTestId) => {
            const node = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (candidate) => candidate.dataset.testid === itemTestId,
            );
            const li = node?.closest("li") ?? node;
            const button = Array.from(li?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
              (b) => b.getAttribute("aria-label") === "归档任务" && !b.disabled,
            );
            if (!button) return false;
            button.click();
            return true;
          },
          testId(TID_TASK_ITEM, taskA.taskId),
        ),
      { timeout: 15_000, interval: 200, timeoutMsg: `${CASE_MARKER}: 归档按钮不可用` },
    );
    await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskA.taskId), {
      timeout: 10_000,
      timeoutMsg: `${CASE_MARKER}: 归档确认按钮没有出现`,
    }).catch(() => undefined);

    const idsBase64 = Buffer.from(JSON.stringify([taskA.taskId])).toString("base64");
    await browser.waitUntil(
      async () => {
        const result = await runSSHCommand(
          prepared.config,
          `python3 - <<'PY'
import base64,json,os,sqlite3
ids=json.loads(base64.b64decode("${idsBase64}"))
path=os.path.expanduser("~/.codez/v2/tasks-index.sqlite")
with sqlite3.connect("file:"+path+"?mode=ro",uri=True) as connection:
    connection.row_factory=sqlite3.Row
    rows=connection.execute("SELECT task_id,archived FROM tasks WHERE task_id IN (?)",ids).fetchall()
    aliases=connection.execute("SELECT path,canonical_key FROM workspace_alias").fetchall()
    print(json.dumps({"rows":[dict(r) for r in rows],"aliases":[dict(a) for a in aliases]}))
PY`,
        );
        if (result.code !== 0)
          throw new Error(`${CASE_MARKER}: 读取 Source task index 失败: ${result.stderr}`);
        const payload = JSON.parse(result.stdout) as {
          rows: Array<{ task_id: string; archived: number }>;
          aliases: Array<{ path: string; canonical_key: string }>;
        };
        const equivalent = payload.aliases.filter(
          (alias) => alias.path === workspaceA || alias.path === `${workspaceA}/`,
        );
        return (
          payload.rows.length === 1 &&
          payload.rows[0]?.task_id === taskA.taskId &&
          payload.rows[0]?.archived === 1 &&
          equivalent.length === 1
        );
      },
      { timeout: 20_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 归档或 alias 收敛没有落库` },
    );
  });
});
