import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import {
  appSettingsSchema,
  resolveWorkspaceKey,
  type CodezProtocolMessage,
} from "@codez/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

test("appSettingsSchema 为记忆配置提供默认值并保留显式提取模型", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.memoryEnabled, false);
  assert.equal(parsed.memoryUseEnabled, true);
  assert.equal(parsed.memoryExtractionEnabled, true);
  assert.equal(parsed.memoryExtractionModel, undefined);

  const withModel = appSettingsSchema.parse({
    memoryEnabled: true,
    memoryUseEnabled: false,
    memoryExtractionEnabled: false,
    memoryExtractionModel: {
      providerId: "zai",
      modelId: "glm-5.3",
      options: { reasoningLevel: "low" },
    },
  });
  assert.equal(withModel.memoryEnabled, true);
  assert.equal(withModel.memoryUseEnabled, false);
  assert.equal(withModel.memoryExtractionEnabled, false);
  assert.deepEqual(withModel.memoryExtractionModel, {
    providerId: "zai",
    modelId: "glm-5.3",
    options: { reasoningLevel: "low" },
  });

  // 显式 null 表示清除专用模型，恢复跟随会话模型。
  const cleared = appSettingsSchema.parse({ memoryExtractionModel: null });
  assert.equal(cleared.memoryExtractionModel, null);
});

test("syncAppRuntimePreferences 推送记忆偏好到活动 agent，并兼容未实现该方法的旧 CLI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-memory-preferences-"));
  setDataBaseDir(dir);
  const previousCommand = process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  const sent: Array<{ key: string; message: CodezProtocolMessage }> = [];
  let refuseMemoryMethod = false;
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async (workspace) => {
    const key = resolveWorkspaceKey(workspace);
    const messages = new Emitter<CodezProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    return new CodezProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      async send(message) {
        sent.push({ key, message });
        if ("id" in message && "method" in message) {
          if (
            refuseMemoryMethod &&
            message.method === "workspace/updateMemoryPreferences"
          ) {
            // 旧 CLI / codex-bridge：方法未实现，-32601 应被 Host 降级忽略。
            messages.fire({
              id: message.id,
              error: { code: -32601, message: "method not found" },
            });
            return;
          }
          // Host 对各偏好推送的结果有严格 schema 校验；桩按方法返回最小合法结果。
          const params = (message as { params?: { workspace?: unknown } }).params;
          if (message.method === "workspace/updateInteractionPreferences") {
            messages.fire({
              id: message.id,
              result: {
                workspace: params?.workspace,
                askUserQuestionAutoResolutionEnabled: true,
                snoozedInteractionCount: 0,
              },
            });
            return;
          }
          if (message.method === "workspace/updateModelIoPreferences") {
            messages.fire({
              id: message.id,
              result: {
                workspace: params?.workspace,
                fullRetentionEnabled: false,
                updatedSessionCount: 0,
              },
            });
            return;
          }
          if (message.method === "workspace/updateMemoryPreferences") {
            messages.fire({
              id: message.id,
              result: { workspace: params?.workspace, updatedSessionCount: 0 },
            });
            return;
          }
          messages.fire({ id: message.id, result: { native: true } });
        }
      },
      dispose() {
        messages.dispose();
        closes.dispose();
      },
      requestTimeoutMs: 5_000,
    });
  });
  const service = createCodezAgentService({
    presentationSurface: "desktop",
    modelSelectionReadinessSource: {
      async getView() {
        throw new Error("legacy provider unavailable");
      },
    },
    accountProviderConfigSource: {
      async read() {
        throw new Error("legacy account unavailable");
      },
      onDidChange() {
        return () => {};
      },
    },
  });
  const workspace = { workspacePath: dir, workspaceIdentity: "ws-memory" };
  try {
    // 建立活动 client（codexRequest 会拉起 workspace agent）。
    await service.codexRequest({ ...workspace, request: { method: "account/read" } });

    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      memoryEnabled: true,
      memoryUseEnabled: false,
      memoryExtractionEnabled: false,
      memoryExtractionModel: { providerId: "zai", modelId: "glm-5.3" },
    });

    const memoryRequest = sent.find(
      ({ message }) =>
        "method" in message && message.method === "workspace/updateMemoryPreferences",
    );
    assert.ok(memoryRequest, "memory preferences push must reach the active client");
    const params = (
      memoryRequest.message as {
        params: {
          workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string };
          preferences: Record<string, unknown>;
        };
      }
    ).params;
    assert.equal(params.workspace.workspacePath, dir);
    assert.equal(params.workspace.workspaceIdentity, "ws-memory");
    assert.equal(params.workspace.workspaceKey, "ws-memory");
    assert.deepEqual(params.preferences, {
      memoryEnabled: true,
      useEnabled: false,
      extractionEnabled: false,
      extractionModel: { providerId: "zai", modelId: "glm-5.3" },
    });

    // 旧 CLI method-not-found：同步不抛错。
    refuseMemoryMethod = true;
    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: true,
      memoryEnabled: false,
      memoryUseEnabled: true,
      memoryExtractionEnabled: true,
      memoryExtractionModel: null,
    });

    // 未携带 memoryEnabled 的旧调用方不触发记忆推送。
    const before = sent.length;
    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: true,
    });
    const newMessages = sent.slice(before);
    assert.equal(
      newMessages.some(
        ({ message }) =>
          "method" in message && message.method === "workspace/updateMemoryPreferences",
      ),
      false,
    );
  } finally {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    if (previousCommand === undefined) delete process.env.CODEZ_AGENT_SERVER_COMMAND;
    else process.env.CODEZ_AGENT_SERVER_COMMAND = previousCommand;
    await rm(dir, { recursive: true, force: true });
  }
});
