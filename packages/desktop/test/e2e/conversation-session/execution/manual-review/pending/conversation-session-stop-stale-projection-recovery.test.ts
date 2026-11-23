import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@codez/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { waitForToastContaining } from "#e2e/helpers/conversation-session-toast";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// 候选用例（spec: specs/codex-desktop-stop-stale-projection.md 验收场景 1/2）。
// 需先完成 manual/capture 与人工 review 才能晋级；类型检查不等于覆盖证据。
//
// 复现路径与线上现场一致：在途轮次期间用 Codex 供应商设置的「重启 app-server」
// 回收该 workspace 的 agent runtime（disposeWorkspace），renderer 投影因此停在
// 幻影 running。此时点击停止，runtime 侧只会回 noop(guard.stopTargetChanged)。
// 修复前：界面无任何反应；修复后：出现提示且投影经既有 recovery 阶梯离开幻影 running。
const RESTART_TRIGGER = "codex-catalog-restart";
const RESTART_CONFIRM = "codex-catalog-restart-confirm";

async function restartWorkspaceAppServerFromSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有打开设置入口",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  // modelProvider 分区直接映射到 providers 面板（codexSettingsNav），不经内部横向标签。
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有供应商分区",
  });
  await clickTestIdByDom(RESTART_TRIGGER, {
    timeout: 30000,
    timeoutMsg: "供应商面板没有可点击的「重启 app-server」入口",
  });
  await clickTestIdByDom(RESTART_CONFIRM, {
    timeout: 15000,
    timeoutMsg: "重启确认按钮没有出现",
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有从设置返回会话",
  });
}

describe("Stop 命中陈旧投影的可见性与自愈候选", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("在途轮次被 workspace runtime 回收后，停止必须给出提示并离开幻影 running", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const marker = `E2E_STOP_STALE_PROJECTION_${runId}`;
    await sendV4Prompt(`E2E_SLOW_STREAM ${marker}: keep streaming until stopped.`);
    await waitForV4ComposerText("", "首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "首轮没有进入 streaming，无法构造在途轮次",
      30000,
    );

    await restartWorkspaceAppServerFromSettings();

    // 记录缺陷现场：runtime 已换代，但面板仍显示 running（停止按钮仍在）。
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "runtime 回收后面板没有保持幻影 running，本用例前置条件不成立",
      15000,
    );

    await clickV4Stop();
    await waitForToastContaining(
      ["正在刷新会话状态", "Refreshing the session state"],
      "停止命中陈旧投影后没有给出可见提示",
    );

    // 既有 recovery 阶梯：resume → forceSnapshot → fail-closed。
    // 无论拿到权威终态还是落 error 面板，都必须离开幻影 running。
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "停止后仍停在幻影 running，投影没有经 recovery 刷新",
      60000,
    );

    // 验收场景 2：连点不得产生第二条恢复路径或订阅风暴。
    await clickV4Stop().catch(() => undefined);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "重复停止后会话又回到 streaming",
      15000,
    );
  });
});
