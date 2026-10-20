import {
  TID_CHAT_LOADING,
  TID_V4_SESSION_PANE,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@codez/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { waitForUpstreamRequest } from "../../../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolCallId } from "../../../helpers/conversation-session-tool.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const PARENT_MARKER = "E2E_SUBAGENT_PROVIDER_RETRY_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_PROVIDER_RETRY_PARENT_DONE";
const CHILD_MARKER = "E2E_SUBAGENT_PROVIDER_RETRY_CHILD";
const CHILD_DONE = "E2E_SUBAGENT_PROVIDER_RETRY_CHILD_DONE";
const TOOL_CALL_ID = "toolu_e2e_subagent_provider_retry_agent";
const MAIN_PANE_SELECTOR = `[data-testid="${testId(TID_V4_SESSION_PANE, "workspace-main")}"]`;
const CHILD_PANE_SELECTOR = '[data-session-id^="sess_subagent_"]';

describe("Main/Subagent provider retry 时间线状态 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT25: 每次 retry 显示计数，点击状态可查看最近错误并随进展消失", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    await sendV4Prompt(
      `${PARENT_MARKER}: launch one background Agent and finish after its completed task notification with ${PARENT_DONE}.`,
    );
    const mainFirstRetryState = await waitForVisiblePane(
      MAIN_PANE_SELECTOR,
      (state) => hasRetryAttemptText(state.liveTailText, 1) && !state.hasGenericLoading,
      "Main 首次 retry 没有显示 1/10 计数",
    );
    expect(mainFirstRetryState.hasGenericLoading).toBe(false);
    await openRetryDetails(MAIN_PANE_SELECTOR, "AccountRateLimitExceeded");

    const mainSecondRetryState = await waitForVisiblePane(
      MAIN_PANE_SELECTOR,
      (state) => hasRetryAttemptText(state.liveTailText, 2) && !state.hasGenericLoading,
      "Main 第二次 retry 没有显示 2/10 计数",
    );
    expect(mainSecondRetryState.hasGenericLoading).toBe(false);

    const mainRetryState = await waitForVisiblePane(
      MAIN_PANE_SELECTOR,
      (state) => hasRetryAttemptText(state.liveTailText, 3) && !state.hasGenericLoading,
      "Main 第三次 retry 没有在当前 turn 用 3/10 状态替换通用 loading",
    );
    expect(mainRetryState.hasGenericLoading).toBe(false);

    await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 60000);
    await waitForVisiblePane(
      MAIN_PANE_SELECTOR,
      (state) => !hasRetryText(state.text),
      "Main 收到有效工具进展后 retry 状态没有清除",
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_MARKER] },
      "subagent retry child 首个请求没有到达 replay server",
      60000,
    );
    await openChildSidePane();

    const retryState = await waitForVisiblePane(
      CHILD_PANE_SELECTOR,
      (state) => hasRetryAttemptText(state.liveTailText, 1) && !state.hasGenericLoading,
      "child 首次 retry 没有显示 1/10 计数",
    );
    expect(retryState.hasGenericLoading).toBe(false);
    await openRetryDetails(CHILD_PANE_SELECTOR, "AccountRateLimitExceeded");

    await waitForVisiblePane(
      CHILD_PANE_SELECTOR,
      (state) => state.text.includes(CHILD_DONE) && !hasRetryText(state.text),
      "child 恢复正文进展后 retry 状态没有清除",
      60000,
    );
    // Bug 原因：完成 token 曾同时出现在 user prompt 与 provider reply，聚合 timeline
    // 查询会被输入行提前满足；只观察 assistant row 才能作为父轮完成屏障。
    await waitForV4AssistantMessageContaining(PARENT_DONE, 90000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "subagent retry case 完成后父会话没有回到 idle",
      60000,
    );
  });
});

async function openChildSidePane() {
  const block = await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 30000);
  const action = await $(`[data-testid="${block.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await action.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "running child 没有右侧会话入口",
  });
  await action.click();
}

async function openRetryDetails(paneSelector: string, expectedText: string) {
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => {
        const pane = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        );
        const trigger = pane?.querySelector<HTMLElement>(
          '[data-testid="v4-api-retry-status"], [data-testid="v4-codex-retry-status"]',
        );
        if (!trigger) return false;
        trigger.click();
        return true;
      }, paneSelector),
    { timeout: 30000, interval: 100, timeoutMsg: "retry 状态详情触发器没有出现" },
  );
  await browser.waitUntil(
    async () =>
      browser.execute((text) => {
        const details = document.querySelector<HTMLElement>(
          '[data-testid="v4-api-retry-status-details"], [data-testid="v4-codex-retry-status-details"]',
        );
        return Boolean(
          details && details.getClientRects().length > 0 && details.innerText.includes(text),
        );
      }, expectedText),
    { timeout: 10000, interval: 100, timeoutMsg: "retry 状态详情浮窗没有显示最近错误" },
  );
}

interface VisiblePaneState {
  hasGenericLoading: boolean;
  liveTailText: string;
  text: string;
}

function hasRetryAttemptText(text: string, attempt: number): boolean {
  return (
    text.includes(`重新连接中... ${attempt}/10`) || text.includes(`Reconnecting... ${attempt}/10`)
  );
}

function hasRetryText(text: string): boolean {
  return text.includes("重新连接中...") || text.includes("Reconnecting...");
}

async function waitForVisiblePane(
  paneSelector: string,
  predicate: (state: VisiblePaneState) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<VisiblePaneState> {
  let latest: VisiblePaneState = {
    hasGenericLoading: false,
    liveTailText: "",
    text: "",
  };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (selector, loadingTestId) => {
          const pane = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
            (candidate) => candidate.getClientRects().length > 0,
          );
          const liveTail = pane?.querySelector<HTMLElement>('[data-v4-running-live-tail="true"]');
          return {
            hasGenericLoading: Boolean(liveTail?.querySelector(`[data-testid="${loadingTestId}"]`)),
            liveTailText: liveTail?.innerText ?? "",
            text: pane?.innerText ?? "",
          };
        },
        paneSelector,
        TID_CHAT_LOADING,
      );
      return predicate(latest);
    },
    { timeout, interval: 100, timeoutMsg },
  );
  return latest;
}
