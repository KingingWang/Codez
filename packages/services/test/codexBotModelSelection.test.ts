import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appSettingsSchema,
  type BotConfig,
  type BotInboundMessage,
  type CodexModel,
  type ModelSelection,
} from "@codez/shared";
import { createBotsService } from "../src/bots/botsService.js";
import type { IBotsService } from "../src/bots/bots.js";
import { createCodexModelSelectionService } from "../src/model-provider/codexModelSelectionService.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type { ICodezTaskService } from "../src/session/codezTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";

const nativeModel = (model: string, isDefault = false): CodexModel => ({
  id: model,
  model,
  displayName: model,
  description: "fixture",
  hidden: false,
  isDefault,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "fixture" },
    { reasoningEffort: "medium", description: "fixture" },
    { reasoningEffort: "high", description: "fixture" },
  ],
});

interface CodexTaskServiceRecorder {
  created: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  resumed: Array<Record<string, unknown>>;
  modelSelections: Array<ModelSelection | null>;
  streamListeners: Array<(event: unknown) => void>;
}

function createCodexTaskServiceStub(recorder: CodexTaskServiceRecorder): ICodezTaskService {
  const stub = {
    async createTask(params: Record<string, unknown>) {
      recorder.created.push(params);
      return { taskId: "task-1", title: "", workspacePath: params.workspacePath };
    },
    async getTaskConfigOptions() {
      return [];
    },
    async listDeletedTaskIds() {
      return [];
    },
    async getTaskSnapshot() {
      return null;
    },
    async listTasks() {
      return [
        {
          taskId: "task-1",
          title: "fixture",
          status: "completed",
          workspacePath: "/repo/bot",
          updatedAt: Date.now(),
        },
      ];
    },
    async getTaskModelSelection() {
      // Codex 会话事实：bridge 侧可能没记录显式档位，由 Host 目录解析补齐。
      return { providerId: "openai", modelId: "gpt-5-codex" };
    },
    async resumeTask(params: Record<string, unknown>) {
      recorder.resumed.push(params);
      return { taskId: params.taskId };
    },
    async sendPrompt(params: Record<string, unknown>) {
      recorder.prompts.push(params);
    },
    onDynamicStreamEvent(taskId: string) {
      void taskId;
      return (listener: (event: unknown) => void) => {
        recorder.streamListeners.push(listener);
        return { dispose() {} };
      };
    },
  };
  return stub as unknown as ICodezTaskService;
}

function createCredentialServiceStub(): ICredentialService {
  const store = new Map<string, string>();
  return {
    async load(key: string) {
      return store.get(key) ?? null;
    },
    async save(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function createSettingServiceStub(workspacePath: string): ISettingService {
  const settings = appSettingsSchema.parse({
    lastWorkspaceSession: [{ kind: "local", workspacePath }],
  });
  return {
    async get() {
      return settings;
    },
    async update() {
      throw new Error("fixture settings are read-only");
    },
  } as unknown as ISettingService;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Bot 首发/跟进在 codex runtime 下解析 Codex 原生模型（飞书报错回归）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-codex-bot-"));
  const workspacePath = join(root, "workspace");
  setDataBaseDir(root);
  const codexCalls: string[] = [];
  const modelSelectionService = createCodexModelSelectionService({
    send: async (params) => {
      codexCalls.push(params.request.method);
      if (params.request.method === "config/read") {
        return {
          config: { model: "gpt-5-codex", model_reasoning_effort: "high" },
          origins: {},
          layers: null,
        };
      }
      return { data: [nativeModel("gpt-5-codex", true)], nextCursor: null };
    },
  });
  const recorder: CodexTaskServiceRecorder = {
    created: [],
    prompts: [],
    resumed: [],
    modelSelections: [],
    streamListeners: [],
  };
  const service: IBotsService = createBotsService({
    credentialService: createCredentialServiceStub(),
    codezTaskService: createCodexTaskServiceStub(recorder),
    settingService: createSettingServiceStub(workspacePath),
    modelSelectionService,
    runStartupBackgroundTasks: false,
  });
  t.after(async () => {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await service.saveBot({
    bot: {
      id: "bot-1",
      name: "fixture-bot",
      provider: "telegram",
      enabled: true,
      allowedWorkspaces: ["*"],
      allowedCommands: {},
      currentOptions: {},
      replyMode: "assistant_changes",
    } as BotConfig,
  });
  const { code } = await service.createBindCode({ botId: "bot-1", allowedWorkspaces: ["*"] });
  const actor = {
    provider: "telegram" as const,
    botId: "bot-1",
    providerUserId: "user-1",
    chatType: "private" as const,
    chatId: "chat-1",
  };
  const message = (text: string): BotInboundMessage => ({ botId: "bot-1", actor, text });

  const bindReplies = await service.handleInboundMessage(message(`/bind ${code}`));
  assert.ok(
    bindReplies.some((reply) => reply.text.includes("绑定成功") || /bind/i.test(reply.text)),
    `绑定回复异常: ${JSON.stringify(bindReplies)}`,
  );

  // 回归断言：旧实现在这里抛「Bot 无法从目标 Host 解析 Submission 模型」。
  const firstReplies = await service.handleInboundMessage(message("帮我看下这个项目"));
  assert.ok(
    !firstReplies.some((reply) => reply.text.includes("无法从目标 Host 解析")),
    `首发不应再报模型解析失败: ${JSON.stringify(firstReplies)}`,
  );
  assert.equal(recorder.created.length, 1, "首发必须创建任务");
  assert.deepEqual(recorder.created[0]?.modelSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });
  await waitFor(() => recorder.prompts.length === 1);
  assert.deepEqual(recorder.prompts[0]?.modelSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });

  // 结束首轮任务，释放 running 门禁。
  for (const listener of recorder.streamListeners) {
    listener({ type: "task_complete", taskId: "task-1" });
  }
  await waitFor(() => recorder.prompts.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 跟进消息：Session 原选择无显式档位，按 Codex 目录默认档补齐。
  const followUpReplies = await service.handleInboundMessage(message("继续改一下"));
  assert.ok(
    !followUpReplies.some(
      (reply) => reply.text.includes("无法从目标 Host 解析") || reply.text.includes("不可用"),
    ),
    `跟进不应再报模型解析失败: ${JSON.stringify(followUpReplies)}`,
  );
  assert.equal(recorder.resumed.length, 1, "跟进必须恢复既有任务");
  await waitFor(() => recorder.prompts.length === 2);
  assert.deepEqual(recorder.prompts[1]?.modelSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "medium" },
  });
  assert.ok(codexCalls.includes("config/read") && codexCalls.includes("model/list"));

  // 跟进同样占用 running 门禁；先结束任务再打开菜单。
  for (const listener of recorder.streamListeners) {
    listener({ type: "task_complete", taskId: "task-1" });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 回到草稿态，/model 才作用于下一次首发。
  await service.handleInboundMessage(message("/new"));

  // /model 菜单：候选必须来自 Codex 原生目录，而不是空 legacy Registry。
  const modelReplies = await service.handleInboundMessage(message("/model"));
  const modelReply = modelReplies.find((reply) => reply.selection);
  assert.ok(modelReply?.selection, `/model 应返回候选菜单: ${JSON.stringify(modelReplies)}`);
  const optionIds = modelReply.selection.options.map((option) => option.id);
  assert.ok(
    optionIds.includes("openai"),
    `/model 候选必须包含 Codex Provider: ${optionIds.join(",")}`,
  );

  // 两级菜单：先选 Provider，再选模型；主动选模按既有语义取目录最高档。
  const providerReplies = await service.handleInboundMessage(message("/model provider openai"));
  const providerReply = providerReplies.find((reply) => reply.selection);
  assert.ok(
    providerReply?.selection,
    `选择 Provider 后应返回模型菜单: ${JSON.stringify(providerReplies)}`,
  );
  const modelIds = providerReply.selection.options.map((option) => option.id);
  assert.ok(
    modelIds.includes("custom:openai:gpt-5-codex"),
    `模型菜单必须包含 Codex 目录模型: ${modelIds.join(",")}`,
  );
  const picked = await service.handleInboundMessage(message("/model custom:openai:gpt-5-codex"));
  assert.ok(
    !picked.some((reply) => reply.text.includes("modelMissing") || reply.text.includes("无法")),
    `选模不应失败: ${JSON.stringify(picked)}`,
  );

  const secondTaskReplies = await service.handleInboundMessage(message("再开一个任务"));
  assert.ok(
    !secondTaskReplies.some((reply) => reply.text.includes("无法从目标 Host 解析")),
    `选模后首发不应再报模型解析失败: ${JSON.stringify(secondTaskReplies)}`,
  );
  assert.equal(recorder.created.length, 2);
  assert.deepEqual(recorder.created[1]?.modelSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });
});

test("Bot /new 继承带 $ 档位后缀的 task.model 时首发不再误报模型解析失败", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-codex-bot-inherit-"));
  const workspacePath = join(root, "workspace");
  setDataBaseDir(root);
  // 自定义 provider：config 指向目录外模型，configuredSelection 是唯一事实源。
  const modelSelectionService = createCodexModelSelectionService({
    send: async (params) => {
      if (params.request.method === "config/read") {
        return {
          config: {
            model_provider: "ollama1",
            model: "deepseek-v4-flash",
            model_reasoning_effort: "xhigh",
          },
          origins: {},
          layers: null,
        };
      }
      return { data: [nativeModel("gpt-5-codex", true)], nextCursor: null };
    },
  });
  const recorder: CodexTaskServiceRecorder = {
    created: [],
    prompts: [],
    resumed: [],
    modelSelections: [],
    streamListeners: [],
  };
  const taskService = createCodexTaskServiceStub(recorder);
  // 回归现场：task.model 是 picker 展示格式 provider/model$effort（带 "$xhigh"）。
  // 旧解析把后缀留在 modelId 里，/new 继承草稿后目录匹配必然 model-not-found。
  taskService.listTasks = async () =>
    [
      {
        taskId: "task-1",
        title: "fixture",
        status: "completed",
        provider: "glm",
        model: "ollama1/deepseek-v4-flash$xhigh",
        workspacePath,
        updatedAt: Date.now(),
      },
    ] as Awaited<ReturnType<ICodezTaskService["listTasks"]>>;
  const service: IBotsService = createBotsService({
    credentialService: createCredentialServiceStub(),
    codezTaskService: taskService,
    settingService: createSettingServiceStub(workspacePath),
    modelSelectionService,
    runStartupBackgroundTasks: false,
  });
  t.after(async () => {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await service.saveBot({
    bot: {
      id: "bot-1",
      name: "fixture-bot",
      provider: "telegram",
      enabled: true,
      allowedWorkspaces: ["*"],
      allowedCommands: {},
      currentOptions: {},
      replyMode: "assistant_changes",
    } as BotConfig,
  });
  const { code } = await service.createBindCode({ botId: "bot-1", allowedWorkspaces: ["*"] });
  const actor = {
    provider: "telegram" as const,
    botId: "bot-1",
    providerUserId: "user-1",
    chatType: "private" as const,
    chatId: "chat-1",
  };
  const message = (text: string): BotInboundMessage => ({ botId: "bot-1", actor, text });
  await service.handleInboundMessage(message(`/bind ${code}`));

  // 首发创建 task-1 并结束，让上下文进入 task 模式。
  const firstReplies = await service.handleInboundMessage(message("先开一个任务"));
  assert.ok(
    !firstReplies.some((reply) => reply.text.includes("无法从目标 Host 解析")),
    `首发不应失败: ${JSON.stringify(firstReplies)}`,
  );
  await waitFor(() => recorder.prompts.length === 1);
  for (const listener of recorder.streamListeners) {
    listener({ type: "task_complete", taskId: "task-1" });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  // /new 继承当前 task 的模型草稿（含 $ 档位后缀的 picker 值）。
  await service.handleInboundMessage(message("/new"));

  // 回归断言：旧实现在这里抛「Bot 无法从目标 Host 解析 Submission 模型」。
  const replies = await service.handleInboundMessage(message("再来一次"));
  assert.ok(
    !replies.some((reply) => reply.text.includes("无法从目标 Host 解析")),
    `/new 后首发不应再报模型解析失败: ${JSON.stringify(replies)}`,
  );
  assert.equal(recorder.created.length, 2, "继承草稿后首发必须创建新任务");
  assert.deepEqual(recorder.created[1]?.modelSelection, {
    providerId: "ollama1",
    modelId: "deepseek-v4-flash",
    options: { reasoningLevel: "xhigh" },
  });
});

test("Bot 首发：目标 Host 无可用模型时保留真实解析错误", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-codex-bot-empty-"));
  const workspacePath = join(root, "workspace");
  setDataBaseDir(root);
  // 空视图模拟未登录 Codex：不能静默成功，必须明确报「无法解析」。
  const emptyModelSelectionService = {
    onDidChange: () => ({ dispose() {} }),
    async getView() {
      return { revision: 0, providers: [] };
    },
  } as unknown as IModelSelectionService;
  const recorder: CodexTaskServiceRecorder = {
    created: [],
    prompts: [],
    resumed: [],
    modelSelections: [],
    streamListeners: [],
  };
  const service: IBotsService = createBotsService({
    credentialService: createCredentialServiceStub(),
    codezTaskService: createCodexTaskServiceStub(recorder),
    settingService: createSettingServiceStub(workspacePath),
    modelSelectionService: emptyModelSelectionService,
    runStartupBackgroundTasks: false,
  });
  t.after(async () => {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await service.saveBot({
    bot: {
      id: "bot-1",
      name: "fixture-bot",
      provider: "telegram",
      enabled: true,
      allowedWorkspaces: ["*"],
      allowedCommands: {},
      currentOptions: {},
      replyMode: "assistant_changes",
    } as BotConfig,
  });
  const { code } = await service.createBindCode({ botId: "bot-1", allowedWorkspaces: ["*"] });
  const actor = {
    provider: "telegram" as const,
    botId: "bot-1",
    providerUserId: "user-1",
    chatType: "private" as const,
    chatId: "chat-1",
  };
  const message = (text: string): BotInboundMessage => ({ botId: "bot-1", actor, text });
  await service.handleInboundMessage(message(`/bind ${code}`));
  await assert.rejects(service.handleInboundMessage(message("你好")), /无法从目标 Host 解析/);
  assert.equal(recorder.created.length, 0, "解析失败时不能创建任务");
});
