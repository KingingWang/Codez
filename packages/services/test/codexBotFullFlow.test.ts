import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appSettingsSchema,
  formatModelPickerValue,
  type BotConfig,
  type BotOutboundMessage,
  type CodexModel,
  type CodezConfigOption,
  type CodezTaskMeta,
  type ModelSelection,
} from "@codez/shared";
import { createBotsService } from "../src/bots/botsService.js";
import type { IBotsService } from "../src/bots/bots.js";
import { createCodexModelSelectionService } from "../src/model-provider/codexModelSelectionService.js";
import type { ICodezTaskService } from "../src/session/codezTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * 飞书/Telegram/微信共用 botsService 核心。这里按 2026-09-24 用户实测环境做全指令
 * 模拟：自定义 provider（ollama1/deepseek-v4-flash$xhigh，不在 Codex 目录）、
 * picker 格式的 task.model（带 "$" 档位后缀）、首发/跟进//new 继承/菜单切换。
 * 目标是让「绑定 → 首发 → 跟进 → /new → 菜单 → /workspace → /stop」全链路在
 * codex runtime 下不再出现「无法从目标 Host 解析 Submission 模型」类失败。
 */

const CUSTOM_SELECTION: ModelSelection = {
  providerId: "ollama1",
  modelId: "deepseek-v4-flash",
  options: { reasoningLevel: "xhigh" },
};

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

interface SimTask {
  taskId: string;
  workspacePath: string;
  provider: string;
  /** 与生产一致：picker 展示格式 provider/model$effort。 */
  model: string;
  status: "running" | "completed";
  selection: ModelSelection;
}

interface SimRecorder {
  created: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  resumed: Array<Record<string, unknown>>;
  setModes: Array<Record<string, unknown>>;
  stopped: Array<Record<string, unknown>>;
}

function createSimTaskService(workspacePath: string) {
  const recorder: SimRecorder = {
    created: [],
    prompts: [],
    resumed: [],
    setModes: [],
    stopped: [],
  };
  const tasks: SimTask[] = [];
  const streamListeners: Array<(event: unknown) => void> = [];
  let seq = 0;

  const configOptions = (task: SimTask): CodezConfigOption[] => [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "yolo",
      options: [
        { value: "build", name: "Build" },
        { value: "plan", name: "Plan" },
        { value: "yolo", name: "Yolo" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: task.selection.options?.reasoningLevel ?? "xhigh",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "XHigh" },
      ],
    },
  ];

  const toMeta = (task: SimTask): CodezTaskMeta =>
    ({
      taskId: task.taskId,
      title: "fixture",
      status: task.status,
      provider: task.provider,
      model: task.model,
      workspacePath: task.workspacePath,
      updatedAt: Date.now(),
    }) as CodezTaskMeta;

  const service = {
    async createTask(params: Record<string, unknown>) {
      recorder.created.push(params);
      seq += 1;
      const selection = (params.modelSelection as ModelSelection | undefined) ?? CUSTOM_SELECTION;
      const task: SimTask = {
        taskId: `task-${seq}`,
        workspacePath: String(params.workspacePath ?? workspacePath),
        provider: "glm",
        model: formatModelPickerValue(selection),
        status: "running",
        selection,
      };
      tasks.unshift(task);
      return { taskId: task.taskId, title: "", workspacePath: task.workspacePath };
    },
    async getTaskConfigOptions(params: { taskId: string }) {
      const task = tasks.find((item) => item.taskId === params.taskId);
      return task ? configOptions(task) : [];
    },
    async listDeletedTaskIds() {
      return [] as string[];
    },
    async getTaskSnapshot() {
      return null;
    },
    async listTasks() {
      return tasks.map(toMeta);
    },
    async getTaskModelSelection(params: { taskId: string }) {
      const task = tasks.find((item) => item.taskId === params.taskId);
      if (!task) return null;
      // 与 bridge snapshot 一致：可能缺显式档位，由目录解析补齐。
      return {
        providerId: task.selection.providerId,
        modelId: task.selection.modelId,
      };
    },
    async resumeTask(params: Record<string, unknown>) {
      recorder.resumed.push(params);
      return { taskId: params.taskId };
    },
    async sendPrompt(params: Record<string, unknown>) {
      recorder.prompts.push(params);
    },
    async setMode(params: Record<string, unknown>) {
      recorder.setModes.push(params);
    },
    async setConfigOption(params: Record<string, unknown>) {
      const task = tasks.find((item) => item.taskId === params.taskId);
      return task ? configOptions(task) : [];
    },
    async stopGeneration(params: Record<string, unknown>) {
      recorder.stopped.push(params);
      const task = tasks.find((item) => item.taskId === params.taskId);
      if (task) task.status = "completed";
    },
    onDynamicStreamEvent(_taskId: string) {
      return (listener: (event: unknown) => void) => {
        streamListeners.push(listener);
        return { dispose() {} };
      };
    },
  };

  const completeTask = (taskId: string) => {
    const task = tasks.find((item) => item.taskId === taskId);
    if (task) task.status = "completed";
    for (const listener of streamListeners) {
      listener({ type: "task_complete", taskId });
    }
  };

  return {
    recorder,
    tasks,
    completeTask,
    service: service as unknown as ICodezTaskService,
  };
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

function assertNoFailureReply(replies: BotOutboundMessage[], label: string): void {
  const text = replies.map((reply) => reply.text).join("\n");
  assert.ok(
    !text.includes("无法从目标 Host 解析") &&
      !text.includes("不可用") &&
      !text.includes("modelMissing"),
    `${label} 不应返回失败文案: ${text}`,
  );
}

test("Bot 全指令模拟：自定义 provider 环境下绑定/首发/跟进///new/菜单/workspace/stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-codex-bot-flow-"));
  const workspacePath = join(root, "workspace");
  setDataBaseDir(root);
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
      // 真实 codex model/list：目录只含内建模型，自定义模型不进目录。
      return { data: [nativeModel("gpt-5-codex", true), nativeModel("gpt-5")], nextCursor: null };
    },
  });
  const sim = createSimTaskService(workspacePath);
  const service: IBotsService = createBotsService({
    credentialService: createCredentialServiceStub(),
    codezTaskService: sim.service,
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
  const say = (text: string): Promise<BotOutboundMessage[]> =>
    service.handleInboundMessage({ botId: "bot-1", actor, text });

  // ---- 绑定与只读指令 ----
  const bindReplies = await say(`/bind ${code}`);
  assert.ok(
    bindReplies.some((reply) => reply.text.includes("绑定成功") || /bind/i.test(reply.text)),
    `绑定回复异常: ${JSON.stringify(bindReplies)}`,
  );
  assertNoFailureReply(await say("/帮助"), "/help");
  assertNoFailureReply(await say("/status"), "/status(draft)");

  // ---- 首发：draft → createTask(v4Create) + 强制 yolo + sendPrompt ----
  await say("hi");
  assert.equal(sim.recorder.created.length, 1, "首发必须创建任务");
  assert.deepEqual(sim.recorder.created[0]?.modelSelection, CUSTOM_SELECTION);
  await waitFor(() => sim.recorder.prompts.length === 1);
  assert.deepEqual(sim.recorder.prompts[0]?.modelSelection, CUSTOM_SELECTION);
  await waitFor(() => sim.recorder.setModes.length === 1);
  assert.equal(sim.recorder.setModes[0]?.mode, "yolo", "Bot 建 task 必须强制 yolo");

  // 运行中再发消息：必须被 taskRunning 门禁拦下，不产生新 prompt。
  const busyReplies = await say("运行中插话");
  assert.ok(
    busyReplies.some((reply) => reply.text.length > 0),
    "运行中应回复提示",
  );
  assert.equal(sim.recorder.prompts.length, 1, "运行中不能再发 prompt");
  sim.completeTask("task-1");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- 跟进：task 模式经 session 原选择 + 目录补齐档位 ----
  await say("继续");
  assert.equal(sim.recorder.resumed.length, 1, "跟进必须恢复既有任务");
  await waitFor(() => sim.recorder.prompts.length === 2);
  assert.deepEqual(sim.recorder.prompts[1]?.modelSelection, CUSTOM_SELECTION);
  sim.completeTask("task-1");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- /new 继承（task.model 带 "$xhigh" 后缀的回归现场）----
  assert.equal(sim.tasks[0]?.model, "ollama1/deepseek-v4-flash$xhigh");
  const newReplies = await say("/new");
  assertNoFailureReply(newReplies, "/new");
  await say("再来一次");
  assert.equal(sim.recorder.created.length, 2, "/new 后首发必须创建新任务");
  assert.deepEqual(
    sim.recorder.created[1]?.modelSelection,
    CUSTOM_SELECTION,
    "继承草稿的 modelId 不得带 $ 档位后缀",
  );
  await waitFor(() => sim.recorder.prompts.length === 3);
  sim.completeTask("task-2");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- 模型菜单：两级选择并固定，随后首发用固定选择 ----
  await say("/new");
  const modelMenu = await say("/模型");
  const providerStep = modelMenu.find((reply) => reply.selection);
  assert.ok(providerStep?.selection, `/model 应返回 provider 菜单: ${JSON.stringify(modelMenu)}`);
  assert.ok(
    providerStep.selection.options.some((option) => option.id === "ollama1"),
    "provider 菜单必须包含 codex 当前 provider",
  );
  const modelStep = await say("/model provider ollama1");
  const modelOptions = modelStep.find((reply) => reply.selection)?.selection.options ?? [];
  assert.ok(
    modelOptions.some((option) => option.id === "custom:ollama1:deepseek-v4-flash"),
    `模型菜单必须包含配置模型: ${modelOptions.map((option) => option.id).join(",")}`,
  );
  const picked = await say("/model model custom:ollama1:deepseek-v4-flash");
  assertNoFailureReply(picked, "/model set");
  await say("固定模型后首发");
  assert.equal(sim.recorder.created.length, 3);
  assert.deepEqual(sim.recorder.created[2]?.modelSelection, CUSTOM_SELECTION);
  await waitFor(() => sim.recorder.prompts.length === 4);
  sim.completeTask("task-3");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- 档位菜单：目录外配置模型只有配置档位可选 ----
  await say("/new");
  const thoughtMenu = await say("/思考");
  const thoughtOptions = thoughtMenu.find((reply) => reply.selection)?.selection.options ?? [];
  assert.ok(
    thoughtOptions.some((option) => option.id === "xhigh"),
    `档位菜单必须包含配置档位: ${thoughtOptions.map((option) => option.id).join(",")}`,
  );
  assertNoFailureReply(await say("/思考 xhigh"), "/thoughtLevel set");

  // ---- mode 锁 yolo / stop / task 列表与切换 ----
  const modeReplies = await say("/mode");
  assert.ok(modeReplies.length > 0 && !modeReplies.some((reply) => reply.selection));
  await say("再跑一个");
  await waitFor(() => sim.recorder.prompts.length === 5);
  const stopReplies = await say("/stop");
  assertNoFailureReply(stopReplies, "/stop");
  assert.equal(sim.recorder.stopped.length, 1, "/stop 必须调用 stopGeneration");

  const taskMenu = await say("/task");
  assert.ok(
    taskMenu.some((reply) => reply.selection || reply.text.length > 0),
    "/task 应返回任务列表",
  );

  // ---- workspace 列表与切换（重建草稿，不继承 task.model）----
  const workspaceMenu = await say("/项目");
  assert.ok(
    workspaceMenu.some((reply) => reply.selection || reply.text.length > 0),
    "/workspace 应返回工作区列表",
  );
  const workspaceSet = await say(`/workspace ${workspacePath}`);
  assertNoFailureReply(workspaceSet, "/workspace set");
  await say("切 workspace 后首发");
  assert.equal(sim.recorder.created.length, 5);
  assert.deepEqual(sim.recorder.created[4]?.modelSelection, CUSTOM_SELECTION);
  await waitFor(() => sim.recorder.prompts.length === 6);
  sim.completeTask("task-5");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- 选择取消与未知命令 ----
  await say("/模型");
  const cancelReplies = await say("0");
  assert.ok(cancelReplies.length >= 0, "选择取消不应抛错");
  const unknownReplies = await say("/不存在指令");
  assert.ok(unknownReplies.length > 0, "未知命令应有提示");

  // ---- 最终状态读取仍正常 ----
  assertNoFailureReply(await say("/status"), "/status(final)");
});
