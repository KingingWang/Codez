// @vitest-environment jsdom

// 接缝测试（specs/codex-desktop-image-view.md）：codex view_image 投影行
// （toolName "view_image" + input.path）经 v4 适配器后必须命中 Read 文件卡片，
// 文件名 chip 可点击、点击打开预览面板渲染图片。防止投影层与 UI 各自正确但
// 接缝断裂、退回 raw JSON 兜底卡。
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallRow } from "@codez/shared/codez-protocol-v4";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { buildReadSummary, ReadToolCallBlock } from "@/ToolCallBlocks/renderers/read.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

const IMAGE_PATH = "/tmp/codex-view-image.png";

function buildViewImageRow(): ToolCallRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    entityId: "codex:turn:turn-1:item:img-1",
    productTurnId: "turn-1",
    visibility: "visible",
    createdAt: 1000,
    createdAtSeq: 0,
    kind: "toolCall",
    toolCallId: "img-1",
    toolName: "view_image",
    status: "success",
    inputText: JSON.stringify({ path: IMAGE_PATH }),
    input: { path: IMAGE_PATH },
  };
}

function buildContext(
  node: ReturnType<typeof toolCallRowToLegacyNode>,
  overrides: Partial<ToolCallBlockRenderContext> = {},
): ToolCallBlockRenderContext {
  return {
    toolCallNode: node,
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    forceOpen: true,
    canToggle: false,
    ...overrides,
  } as ToolCallBlockRenderContext;
}

afterEach(cleanup);

describe("codex view_image tool card seam", () => {
  it("routes the projected view_image row to the read renderer", () => {
    const node = toolCallRowToLegacyNode(buildViewImageRow());
    expect(resolveToolCallRenderer(buildContext(node))).toBe(ReadToolCallBlock);
  });

  it("extracts the image file chip summary from the projected input path", () => {
    const node = toolCallRowToLegacyNode(buildViewImageRow());
    const summary = buildReadSummary(node.toolCall);
    expect(summary?.entryType).toBe("file");
    expect(summary?.path).toBe(IMAGE_PATH);
    expect(summary?.fileName).toBe("codex-view-image.png");
  });

  it("renders the clickable file name and opens the preview pane target", () => {
    const node = toolCallRowToLegacyNode(buildViewImageRow());
    const onOpenCodeViewer = vi.fn();
    render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ReadToolCallBlock as never,
          buildContext(node, { onOpenCodeViewer }) as never,
        ),
      ),
    );
    const chip = screen.getByText("codex-view-image.png");
    chip.click();
    expect(onOpenCodeViewer).toHaveBeenCalledWith({
      type: "file",
      title: "codex-view-image.png",
      path: IMAGE_PATH,
    });
  });
});
