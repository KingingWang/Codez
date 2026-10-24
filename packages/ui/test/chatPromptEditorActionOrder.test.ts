import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { codexModelSchema } from "@codez/shared";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { CodexComposerModelControls } from "@/settings/codex/CodexComposerModelControls.js";
import { CodexFollowupModeMenu } from "@/v4/composer/CodexFollowupModeMenu.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/LexicalChatInput.js", async () => {
  const React = await import("react");
  return {
    LexicalChatInput: () => React.createElement("div", { "data-testid": "lexical-input" }),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useCodezIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/prompt-editor/ChatPromptActionMenu.js", async () => {
  const React = await import("react");
  return {
    ChatPromptActionMenu: ({
      excludedSlashCommandNames,
    }: {
      excludedSlashCommandNames?: readonly string[];
    }) =>
      React.createElement("div", {
        "data-testid": "composer-action-menu",
        "data-excluded": excludedSlashCommandNames?.join(","),
      }),
  };
});

vi.mock("@/prompt-editor/usePromptEditorDragState.js", () => ({
  usePromptEditorDragState: () => ({
    externalFileDragging: false,
    internalDragging: false,
    setExternalFileDragging: vi.fn(),
    setInternalDragging: vi.fn(),
    setWorkspaceFileDragging: vi.fn(),
    workspaceFileDragging: false,
  }),
}));

describe("ChatPromptEditor action menu", () => {
  it("passes side chat command exclusions to the action menu", () => {
    const html = renderToStaticMarkup(
      createElement(ChatPromptEditor, {
        workspacePath: "/tmp/workspace",
        taskId: null,
        submitLabel: "Send",
        showMentionButton: true,
        excludedSlashCommandNames: ["goal"],
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('data-excluded="goal"');
  });

  // Side Pane 完整视图浮窗：[+] 输入区 [控件][发送] 排成一行（docs/ui/side-pane-full-view.md）。
  it("moves the action menu before the editor only in the inline layout", () => {
    const render = (layout: "stacked" | "inline") =>
      renderToStaticMarkup(
        createElement(ChatPromptEditor, {
          workspacePath: "/tmp/workspace",
          taskId: null,
          submitLabel: "Send",
          showMentionButton: true,
          layout,
          onSubmit: vi.fn(),
        }),
      );
    const order = (html: string) =>
      ["composer-action-menu", "lexical-input", "data-composer-leading-content"].map((marker) =>
        html.indexOf(marker),
      );

    const inline = render("inline");
    expect(inline).toContain('data-composer-layout="inline"');
    const [inlineMenu, inlineEditor, inlineToolbar] = order(inline);
    expect(inlineMenu).toBeLessThan(inlineEditor);
    expect(inlineEditor).toBeLessThan(inlineToolbar);

    const stacked = render("stacked");
    expect(stacked).toContain('data-composer-layout="stacked"');
    const [stackedMenu, stackedEditor, stackedToolbar] = order(stacked);
    expect(stackedEditor).toBeLessThan(stackedToolbar);
    expect(stackedToolbar).toBeLessThan(stackedMenu);
  });

  // 修复回归：Codex shrinkTrailingActions（max-w-[calc(100%-5rem)]）只能在两行 stacked 布局生效；
  // 单行 inline 浮窗开启后会挤爆首行宽度并折成两行。
  it("applies shrinkTrailingActions only in stacked layout, keeping inline trailing actions shrink-0", () => {
    const renderWithShrink = (layout: "stacked" | "inline") =>
      renderToStaticMarkup(
        createElement(ChatPromptEditor, {
          workspacePath: "/tmp/workspace",
          taskId: null,
          submitLabel: "Send",
          showMentionButton: true,
          shrinkTrailingActions: true,
          layout,
          onSubmit: vi.fn(),
        }),
      );

    const inlineHtml = renderWithShrink("inline");
    expect(inlineHtml).not.toContain("max-w-[calc(100%-5rem)]");

    const stackedHtml = renderWithShrink("stacked");
    expect(stackedHtml).toContain("max-w-[calc(100%-5rem)]");
  });

  it("keeps CodexComposerModelControls and CodexFollowupModeMenu compatible with iconOnly inline toolbar", () => {
    const model = codexModelSchema.parse({
      id: "gpt-5",
      model: "gpt-5",
      displayName: "GPT-5",
      description: "test model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
    });
    const controlsHtml = renderToStaticMarkup(
      createElement(CodexComposerModelControls, {
        read: {
          status: "ready",
          catalog: {
            providerId: "openai",
            models: [model],
            groups: [{ providerId: "openai", providerName: "OpenAI", models: [model] }],
            preferredSelection: {
              providerId: "openai",
              modelId: "gpt-5",
              options: { reasoningLevel: "medium" },
            },
          },
          reload: () => {},
          readCurrent: async () => {
            throw new Error("unused");
          },
        },
        selection: {
          providerId: "openai",
          modelId: "gpt-5",
          options: { reasoningLevel: "medium" },
        },
        disabled: false,
        onSelectModel: () => {},
        onSelectThought: () => {},
      }),
    );
    expect(controlsHtml).toContain("composer-model-trigger");
    expect(controlsHtml).toContain("w-fit");
    expect(controlsHtml).toContain("group-data-[composer-model-icon=true]/toolbar:px-1.5");
    expect(controlsHtml).not.toContain("group-data-[composer-model-icon=true]/toolbar:size-7");

    const followupHtml = renderToStaticMarkup(
      createElement(CodexFollowupModeMenu, {
        intent: "guide",
        disabled: false,
        onChange: () => {},
      }),
    );
    expect(followupHtml).toContain('data-composer-collapse-priority="2"');
    expect(followupHtml).toContain("data-[composer-compact=true]:w-7");
    expect(followupHtml).toContain("group-data-[composer-compact=true]/followup:hidden");
  });
});
