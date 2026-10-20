// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@codez/shared";
import type { ReasoningRow, ToolCallRow } from "@codez/shared/codez-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const noopPlatform = {} as IPlatformService;

function renderRow(row: ToolCallRow | ReasoningRow, context: Partial<ConversationRowRenderContext>) {
  const mergedContext: ConversationRowRenderContext = {
    workspacePath: "/workspace",
    theme: "system",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    ...context,
  };
  return render(
    createElement(
      CodezIntlProvider,
      { locale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: noopPlatform },
        createElement(
          TooltipProvider,
          null,
          createElement(ConversationRowView, { row, context: mergedContext }),
        ),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("V4 折叠工具卡与思考块按需拉取完整载荷", () => {
  it("Bash 工具卡在收起态不触发 onLoadRowPayload，点击展开后自动触发一次；失败时展示重试按钮", async () => {
    const onLoadRowPayload = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const bashRow: ToolCallRow = {
      rowId: 12,
      turnId: "turn-1",
      createdAt: 1_700_000_000_012,
      createdAtSeq: 12,
      kind: "toolCall",
      toolCallId: "bash-lazy-1",
      toolName: "Bash",
      status: "success",
      inputText: '{"command":"pnpm test"}',
      input: { command: "pnpm test" },
      output: {
        text: "preview output\n…",
        truncated: { totalBytes: 8192, ref: "v4-row-payload/12" },
      },
    };

    const view = renderRow(bashRow, { onLoadRowPayload });
    // 收起态不触发网络请求，也不渲染底部的 snapshot 提示条
    expect(onLoadRowPayload).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Load full tool data");

    const toggleBtn = view.container.querySelector("[role='button']");
    expect(toggleBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(toggleBtn!);
    });

    expect(onLoadRowPayload).toHaveBeenCalledTimes(1);
    expect(onLoadRowPayload).toHaveBeenCalledWith(12);
    expect(view.container.textContent).toContain("Load failed, retry");

    const retryBtn = Array.from(view.container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Load failed, retry"),
    );
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(retryBtn!);
    });
    expect(onLoadRowPayload).toHaveBeenCalledTimes(2);
  });

  it("被截断的 ReasoningRow 在收起态不触发 onLoadRowPayload，点击展开时自动拉取", async () => {
    const onLoadRowPayload = vi.fn().mockResolvedValue(true);
    const reasoningRow: ReasoningRow = {
      rowId: 7,
      turnId: "turn-1",
      createdAt: 1_700_000_000_007,
      createdAtSeq: 7,
      kind: "reasoning",
      state: "complete",
      durationMs: 3000,
      text: "思考摘要预览…",
      truncated: { totalBytes: 4096, ref: "v4-row-payload/7" },
    };

    const view = renderRow(reasoningRow, {
      onLoadRowPayload,
      messageStreamShowReasoning: true,
    });
    expect(onLoadRowPayload).not.toHaveBeenCalled();

    const trigger = view.container.querySelector("button");
    expect(trigger).toBeTruthy();
    await act(async () => {
      fireEvent.click(trigger!);
    });

    expect(onLoadRowPayload).toHaveBeenCalledTimes(1);
    expect(onLoadRowPayload).toHaveBeenCalledWith(7);
  });
});
