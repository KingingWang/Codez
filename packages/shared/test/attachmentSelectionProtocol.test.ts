import { describe, expect, it } from "vitest";
import { codezSessionSendParamsSchema } from "../src/codez-protocol/index.js";
import { commandPayloadSchemas } from "../src/codez-protocol-v4/command.js";
import { attachmentRefSchema } from "../src/codez-protocol-v4/attachment-ref.js";

describe("附件与文本发送的模型合同", () => {
  const modelSelection = {
    providerId: "account:offpeak",
    modelId: "model",
    options: { reasoningLevel: "high" },
  };
  const modelExecution = {
    selectionScope: "execution",
    memoryExtraction: "skip",
    requestAuth: { headers: { "x-test-ticket": "fixture-only" } },
    subagents: { foregroundModel: "submission", background: "deny" },
  };
  it("两种发送保留相同 Selection 与执行约束", () => {
    const legacy = codezSessionSendParamsSchema.parse({
      sessionId: "session",
      content: "hi",
      attachments: [],
      modelSelection,
      modelExecution,
    });
    const current = commandPayloadSchemas.sendText.parse({
      text: "hi",
      modelSelection,
      modelExecution,
    });
    expect(legacy.modelSelection).toEqual(current.modelSelection);
    expect(legacy.modelExecution).toEqual(current.modelExecution);
  });
  it("缺 Selection 或非法执行范围不能通过附件入口绕过校验", () => {
    expect(
      codezSessionSendParamsSchema.safeParse({ sessionId: "s", content: "hi", modelExecution })
        .success,
    ).toBe(false);
    expect(
      codezSessionSendParamsSchema.safeParse({
        sessionId: "s",
        content: "hi",
        modelSelection,
        modelExecution: { ...modelExecution, selectionScope: "session" },
      }).success,
    ).toBe(false);
  });
  it("topic-history 与 clipboard-text 同时保留，话题消息数量受严格校验", () => {
    const ref = { ref: "fixture", fileName: "history.txt", mime: "text/plain", bytes: 8 };
    expect(
      attachmentRefSchema.parse({ ...ref, sourceKind: "topic-history", messageCount: 2 }),
    ).toEqual({ ...ref, sourceKind: "topic-history", messageCount: 2 });
    expect(attachmentRefSchema.parse({ ...ref, sourceKind: "clipboard-text" }).sourceKind).toBe(
      "clipboard-text",
    );
    expect(attachmentRefSchema.safeParse({ ...ref, messageCount: -1 }).success).toBe(false);
  });
  it("上游 guarded 与 fork custom 模式同时保留", () => {
    for (const mode of ["guarded", "custom"]) {
      expect(commandPayloadSchemas.switchCollaborationMode.parse({ mode }).mode).toBe(mode);
    }
  });
});
