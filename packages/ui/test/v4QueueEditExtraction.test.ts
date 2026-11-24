import { describe, expect, it, vi } from "vitest";
import {
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
} from "@/v4/ConversationComposer.js";

// 队列撤回编辑已从「deleteQueueItem + 恢复 composer 草稿」重构为「提交改投 editQueueItem +
// 服务端队列锁」（见 SessionPane 的 editQueueItem 路由与 codex-bridge writer-conflict /
// bootstrap product-projection / E2E conversation-session-queue-edit-freeze 回归）。
// 旧设计的 resolveQueuedComposerRestore / shouldRestoreQueuedComposerFromAck /
// applyComposerRestoreRequestToComposer 已随重构移除；本文件保留仍然有效的
// composer 草稿恢复与 mention 结构化恢复用例。

describe("v4 queue edit extraction", () => {
  it("Workspace 插件页重挂载时从共享草稿恢复结构化 mention", () => {
    const mention = {
      id: "plugin:document-skills@official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@official",
      markdown: "[@文档技能](plugin://document-skills@official)",
      data: { pluginId: "document-skills@official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} 整理文档`;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention, updatedAt: 1 },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " 整理文档");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("商店试用把 canonical 前缀恢复为结构化 Plugin mention", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: {
        pluginId: "demo@mkt",
        icon: "https://cdn.example.com/demo.png",
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} Diagnose this workspace`;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 7, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(7);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " Diagnose this workspace");
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(requestFocus).toHaveBeenCalledTimes(1);
  });

  it("插件安装完成后把唯一 chip 前置到编辑器当前正文而不回放旧 prompt", () => {
    const mention = {
      id: "plugin:document-skills@codez-plugins-official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@codez-plugins-official",
      markdown: "[@文档技能](plugin://document-skills@codez-plugins-official)",
      data: { pluginId: "document-skills@codez-plugins-official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => `${mention.markdown} 用户安装期间编辑后的正文`),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 8,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(8);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(updateText).toHaveBeenCalledWith(`${mention.markdown} 用户安装期间编辑后的正文`);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("当前草稿已有同一 Plugin canonical 文本时不重复插入 chip", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: { pluginId: "demo@mkt" },
    };
    const inputApi = {
      // label 是 display-only；即使语言切换导致 label 不同，同一 stable ID 也不能重复插入。
      getMarkdown: vi.fn(() => "[@旧名称](plugin://demo@mkt) 当前正文"),
      prependMentionIfMissing: vi.fn(() => false),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 9,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus: vi.fn(),
        scheduleDraftPersist: vi.fn(),
        updateText,
      }),
    ).toBe(9);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(updateText).not.toHaveBeenCalled();
  });

});
