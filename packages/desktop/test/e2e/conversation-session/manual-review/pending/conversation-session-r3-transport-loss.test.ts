import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { waitForPermissionInteractionId } from "#e2e/helpers/permission-interaction-id";
import { readRemoteToolExecutionEvents } from "#e2e/helpers/remote-tool-execution-evidence";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  countUpstreamRequests,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readTaskRowInProject,
  sendSSHFollowTurn,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
  terminateRemoteProcess,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "../../../helpers/ssh-remote-p0.js";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  hasV4PermissionDialog,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4QueueCount,
  waitForV4Pane,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_R3_TRANSPORT_LOSS";
const artifactDir = resolve(
  process.env.CODEZ_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-transport-loss",
);
const REMOTE_PERMISSION_DIR = "/home/dev/r3-workspace-a/.codez-e2e/r3-transport-loss";
const REMOTE_PERMISSION_FILE = `${REMOTE_PERMISSION_DIR}/permission-output.txt`;
const PERMISSION_EXECUTION = { toolCallId: "toolu_r3_task_permission", toolName: "Write" };
const run = promisify(execFile);
const runtimeVariant = process.env.CODEZ_DESKTOP_RUNTIME?.trim() === "legacy" ? "legacy" : "codex";

/**
 * Runtime 变体由外层 WDIO 启动选择：默认是 Codex native bridge，显式
 * CODEZ_DESKTOP_RUNTIME=legacy 时才运行旧 app-server --stdio。同一 Electron 进程内不能
 * 热切换 Desktop runtime，因此两种 flavor 必须由远程队列作为独立执行项覆盖。
 */
function requireRuntimeVariant(): "legacy" | "codex" {
  const value = process.env.CODEZ_DESKTOP_RUNTIME?.trim() || "codex";
  if (value !== runtimeVariant) {
    throw new Error(`${CASE_MARKER}: CODEZ_DESKTOP_RUNTIME 在测试启动后发生变化`);
  }
  return value as "legacy" | "codex";
}

function remoteServerRoot(runtime: "legacy" | "codex"): string {
  return runtime === "legacy" ? "$HOME/.codez/server" : "$HOME/.codez-codex/server";
}

async function readCoreIdentity(
  config: SSHConnectionConfig,
  runtime: "legacy" | "codex",
): Promise<{ pid: number; startTicks: number }> {
  const statusResult = await runSSHCommand(
    config,
    `cat "${remoteServerRoot(runtime)}/run/status.json"`,
  );
  if (statusResult.code !== 0) {
    throw new Error(`${CASE_MARKER}: 读取远端 Core status 失败: ${statusResult.stderr}`);
  }
  const status = JSON.parse(statusResult.stdout) as { pid?: unknown };
  const pid = status.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${CASE_MARKER}: Core status 缺少有效 pid`);
  }
  const proc = await runSSHCommand(
    config,
    `test -r /proc/${pid}/stat && awk '{print $22}' /proc/${pid}/stat`,
  );
  const startTicks = Number.parseInt(proc.stdout.trim(), 10);
  if (!Number.isSafeInteger(startTicks)) {
    throw new Error(`${CASE_MARKER}: Core /proc identity 不完整: ${proc.stdout.trim()}`);
  }
  return { pid, startTicks };
}

/**
 * 只切断 Desktop（用户 dev）的 SSH 会话：模型回放反向隧道由独立用户 tunnel 承载，必须保留，
 * 否则远端 Agent 的模型请求会随之失败，无法区分"传输中断"与"模型不可达"。
 */
async function severDesktopSshSessions(container: string): Promise<string> {
  const script = [
    "target_uid=$(id -u dev); killed=''",
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = 1 ] && continue',
    "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue; case \"$c\" in *sshd*) ;; *) continue;; esac",
    'uid=$(awk \'/^Uid:/ {print $2}\' "$d/status"); [ "$uid" = "$target_uid" ] || continue',
    'parent=$(awk \'{print $4}\' "$d/stat"); kill -9 "$p" 2>/dev/null && killed="$killed $p"',
    '[ "$parent" != 1 ] && kill -9 "$parent" 2>/dev/null && killed="$killed $parent"; done',
    "echo $killed",
  ].join("; ");
  const result = await run("docker", ["exec", container, "sh", "-c", script]);
  return result.stdout.trim().split(/\s+/u).filter(Boolean).join(",");
}

async function waitForSessionRegeneration(
  identity: string,
  previous: string,
  label: string,
): Promise<string> {
  let latest: string | null = null;
  await browser.waitUntil(
    async () => {
      const snapshot = await readRemoteTabSnapshot(identity).catch(() => null);
      if (snapshot?.remoteSessionId && snapshot.remoteSessionId !== previous) {
        latest = snapshot.remoteSessionId;
        return true;
      }
      return false;
    },
    {
      interval: 1000,
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: workspace ${label} 传输中断后没有自动换代恢复`,
    },
  );
  return latest!;
}

async function remoteAgentProcess(
  config: SSHConnectionConfig,
  workspacePath: string,
  runtime: "legacy" | "codex",
): Promise<{ pid: number; startTicks: number } | null> {
  // 模板字符串里不能直接写 ${d#/proc/}；用 basename 取 PID。
  const script = [
    "r=",
    'for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue',
    // 两种 runtime 的 Agent 都按实际 argv 匹配：legacy 是 app-server --stdio；
    // Codex native 由 bridge 拉起 app-server --listen stdio://。
    runtime === "legacy"
      ? `case "$c" in *"app-server --stdio"*) [ "$(readlink $d/cwd)" = "${workspacePath}" ] && r="$(basename "$d") $(awk '{print $22}' "$d/stat")";; esac`
      : `case "$c" in *"app-server --listen stdio://"*) [ "$(readlink $d/cwd)" = "${workspacePath}" ] && r="$(basename "$d") $(awk '{print $22}' "$d/stat")";; esac`,
    "done",
    "echo $r",
  ].join("; ");
  const result = await runSSHCommand(config, script);
  const fields = result.stdout.trim().split(/\s+/u);
  const pid = Number.parseInt(fields[0] ?? "", 10);
  const startTicks = Number.parseInt(fields[1] ?? "", 10);
  return Number.isSafeInteger(pid) && Number.isSafeInteger(startTicks) ? { pid, startTicks } : null;
}

describe(`${CASE_MARKER} (${runtimeVariant}): 产品 SSH 连接中断期间远端任务继续，恢复后同组换代且阻塞权限保留`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "transport-loss.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-REC-01/03/09 running 中断连→daemon 与任务继续、A/B 自动换代；permission 阻塞跨断连恢复同 ID 并只响应一次", async function () {
    this.timeout(35 * 60_000);
    const runtime = requireRuntimeVariant();
    facts.runtime = runtime;
    const container = process.env.CODEZ_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 缺少 CODEZ_E2E_SSH_CONTAINER`);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    await runSSHCommand(prepared.config, `rm -rf "${REMOTE_PERMISSION_DIR}"`);
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
    const hosts = await readHostProcesses();
    const core0 = await readCoreIdentity(prepared.config, runtime);
    const agentB0 = await remoteAgentProcess(prepared.config, workspaceB, runtime);
    expect(agentB0).not.toBeNull();

    // REC-01：切回 A（当前 active 是后连接的 B），A 进入 45s controlled-stream running，随后切断 Desktop 的 SSH 会话。
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      expectedRemoteSessionId: taskA.remoteSessionId,
    });
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_TLOSS_STREAMING", 60_000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId === taskA.taskId,
      "A 没有进入 running",
      45_000,
    );
    const agentA0 = await remoteAgentProcess(prepared.config, workspaceA, runtime);
    expect(agentA0).not.toBeNull();
    facts.severedSessions = await severDesktopSshSessions(container);
    const regeneratedA = await waitForSessionRegeneration(
      taskA.identity,
      taskA.remoteSessionId,
      "A",
    );
    const regeneratedB = await waitForSessionRegeneration(
      taskB.identity,
      taskB.remoteSessionId,
      "B",
    );
    facts.regenerated = { A: regeneratedA, B: regeneratedB };
    // daemon/Agent 不受传输中断影响：Core 与两个 Agent 身份不变；任务未被判 failed，流在恢复后收口。
    const core1 = await readCoreIdentity(prepared.config, runtime);
    expect(core1.pid).toBe(core0.pid);
    expect(core1.startTicks).toBe(core0.startTicks);
    expect(await remoteAgentProcess(prepared.config, workspaceA, runtime)).toEqual(agentA0);
    expect(await remoteAgentProcess(prepared.config, workspaceB, runtime)).toEqual(agentB0);
    expect(await readHostProcesses()).toEqual(hosts);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 断连恢复后 A 的 running turn 没有正常收口`,
      120_000,
    );
    const messages = await browser.execute(() => document.body?.innerText ?? "");
    expect(messages).not.toMatch(/任务失败|task failed/iu);
    facts.aTurnCompletedAfterReconnect = true;

    // B 在恢复后续发：历史保留、不含 A 的内容。
    const resumedB: SSHLifecycleTask = { ...taskB, remoteSessionId: regeneratedB };
    await readTaskRowInProject(resumedB, CASE_MARKER);
    await sendSSHFollowTurn(resumedB, CASE_MARKER, taskA.firstPrompt);

    // REC-09（Desktop 自动恢复路径）：A 的 permission 阻塞在断连期间保留；恢复后同一请求只被响应一次。
    const resumedA: SSHLifecycleTask = { ...taskA, remoteSessionId: regeneratedA };
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      expectedRemoteSessionId: regeneratedA,
    });
    const permissionStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_PERMISSION 请写入文件 ${REMOTE_PERMISSION_FILE}`);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_PERMISSION`] },
      `${CASE_MARKER}: 权限 turn 没有到达回放`,
      60_000,
      { afterIndex: permissionStart - 1 },
    );
    const dock = await waitForV4PermissionDialogInComposerDock(60_000);
    expect(dock.inDock).toBe(true);
    const pendingId = await waitForPermissionInteractionId(CASE_MARKER);
    facts.permissionDialogIdBeforeSever = pendingId;
    facts.severedSessionsSecond = await severDesktopSshSessions(container);
    const regeneratedA2 = await waitForSessionRegeneration(
      taskA.identity,
      regeneratedA,
      "A(second)",
    );
    facts.regeneratedA2 = regeneratedA2;
    await browser.waitUntil(() => hasV4PermissionDialog(), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 恢复后权限对话框没有重新出现`,
    });
    const restoredId = await waitForPermissionInteractionId(CASE_MARKER);
    facts.permissionDialogIdAfterRecover = restoredId;
    expect(restoredId).toBe(pendingId);
    expect(
      (
        await runSSHCommand(
          prepared.config,
          `test -f "${REMOTE_PERMISSION_FILE}" && echo exists || echo absent`,
        )
      ).stdout.trim(),
    ).toBe("absent");
    const executionQuery = { sessionId: taskA.taskId, toolName: PERMISSION_EXECUTION.toolName };
    expect(await readRemoteToolExecutionEvents(prepared.config, executionQuery)).toEqual([]);
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("R3_TLOSS_PERMISSION_DONE", 90_000);
    const written = await runSSHCommand(
      prepared.config,
      `cat "${REMOTE_PERMISSION_FILE}"; echo; grep -c R3_TLOSS_PERMISSION_RESULT "${REMOTE_PERMISSION_FILE}"`,
    );
    expect(written.stdout).toContain("R3_TLOSS_PERMISSION_RESULT");
    expect(written.stdout.trim().endsWith("1")).toBe(true);
    await browser.pause(2000);
    expect(await hasV4PermissionDialog()).toBe(false);
    facts.permissionResolvedOnce = written.stdout.trim();
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 权限 turn 没有回到 idle`,
      60_000,
    );
    let executions = await readRemoteToolExecutionEvents(prepared.config, executionQuery);
    await browser.waitUntil(
      async () => {
        executions = await readRemoteToolExecutionEvents(prepared.config, executionQuery);
        facts.remoteToolExecutions = executions;
        return executions.some((event) => event.event === "tool.call.completed");
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 远端 Write 缺少完成事件` },
    );
    expect(executions.filter((event) => event.event === "tool.call.started")).toHaveLength(1);
    expect(executions.filter((event) => event.event === "tool.call.completed")).toHaveLength(1);
    expect(executions.every((event) => event.toolCallId === PERMISSION_EXECUTION.toolCallId)).toBe(
      true,
    );
    expect((await getV4PaneSnapshot()).canStop).toBe(false);
    expect(await readHostProcesses()).toEqual(hosts);
  });

  it("R3A-REC-07 running Agent 真崩溃后不自动续跑，遗留 admitted 输入不发起模型请求且历史保留", async function () {
    this.timeout(20 * 60_000);
    const runtime = requireRuntimeVariant();
    const crashRunningMarker = `${CASE_MARKER}_SLOW`;
    const crashQueuedMarker = `${CASE_MARKER}_CRASH_QUEUE`;
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const workspacePath = prepared.config.workspacePaths[0];
    await runSSHCommand(prepared.config, `rm -rf "${REMOTE_PERMISSION_DIR}"`);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath,
    });

    const requestStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${crashRunningMarker} 慢慢回答`);
    await waitForV4TimelineContaining("R3_TLOSS_STREAMING", 60_000);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [crashRunningMarker] },
      `${CASE_MARKER}: 崩溃前 running turn 没有到达回放`,
      60_000,
      { afterIndex: requestStart - 1 },
    );
    await waitForV4Pane(
      (snapshot) => snapshot.canStop && snapshot.sessionId === task.taskId,
      `${CASE_MARKER}: 崩溃前任务没有进入 running`,
      60_000,
    );
    await sendV4Prompt(`${crashQueuedMarker}: 崩溃后不得自动执行`);
    await waitForV4QueueCount(1, 30_000);

    const agent = await remoteAgentProcess(prepared.config, workspacePath, runtime);
    expect(agent).not.toBeNull();
    await terminateRemoteProcess(prepared.config, agent!, CASE_MARKER);
    const crashFacts: Record<string, unknown> = {
      runtime,
      agent,
      queuedMarker: crashQueuedMarker,
    };
    facts.crash = crashFacts;

    await browser.waitUntil(
      async () => {
        const current = await remoteAgentProcess(prepared.config, workspacePath, runtime);
        return Boolean(current && current.pid !== agent!.pid);
      },
      {
        timeout: 120_000,
        interval: 1000,
        timeoutMsg: `${CASE_MARKER}: Agent 崩溃后没有拉起可打开历史的新 runtime`,
      },
    );
    await selectV4TaskById(task.taskId, 60_000);
    await waitForV4TimelineContaining(task.firstPrompt, 60_000);
    await browser.pause(3000);
    expect(
      await countUpstreamRequests(
        {
          includes: [crashQueuedMarker],
          excludes: ["Generate a concise title"],
        },
        { afterIndex: requestStart - 1 },
      ),
    ).toBe(0);
    expect(
      await countUpstreamRequests(
        {
          includes: [crashRunningMarker],
          excludes: ["Generate a concise title"],
        },
        { afterIndex: requestStart - 1 },
      ),
    ).toBe(1);
    crashFacts.noAutomaticContinuation = true;
  });
});
