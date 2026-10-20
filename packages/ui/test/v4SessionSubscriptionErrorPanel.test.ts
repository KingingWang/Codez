// @vitest-environment jsdom

import type { IPlatformService } from "@codez/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";

const screenshot = {
  filename: "session-subscription-error.png",
  contentType: "image/png",
  dataBase64: "c2NyZWVuc2hvdA==",
  size: 10,
};
const captureWindowScreenshot = vi.fn(async () => screenshot);
const openExternal = vi.fn();
const platform = {
  captureWindowScreenshot,
  openExternal,
} as unknown as IPlatformService;

function renderPanel() {
  return render(
    createElement(
      CodezIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform },
        createElement(SessionSubscriptionErrorPanel, {
          error: "EPERM: operation not permitted",
          sessionId: "session-1",
          workspacePath: "F:\\Codez_data",
          onReconnect: vi.fn(),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    submissionJobId: null,
    selectedTicketId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionSubscriptionErrorPanel", () => {
  it("shows the subscription error with report and reconnect actions", () => {
    renderPanel();

    expect(screen.getByText("EPERM: operation not permitted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "反馈问题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  });

  it("opens a GitHub prefilled issue with the subscription error context", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "反馈问题" }));

    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(useFeedbackStore.getState().open).toBe(false);
    const openedUrl = openExternal.mock.calls[0]?.[0] ?? "";
    expect(openedUrl).toContain("https://github.com/KingingWang/Codez/issues/new?");
    const decoded = decodeURIComponent(openedUrl).replaceAll("+", " ");
    expect(decoded).toContain("EPERM: operation not permitted");
    expect(decoded).toContain("报错摘要：EPERM: operation not permitted");
    expect(decoded).toContain("任务 ID: session-1");
    expect(decoded).toContain("工作区: F:\\Codez_data");
  });
});
