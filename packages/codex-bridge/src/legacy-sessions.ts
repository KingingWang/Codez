import * as shared from "@codez/shared";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import { decorateNativeThread, selectionOverrides, turnMode } from "./command-input.js";
import { turnPermissionIntent } from "./control-common.js";
import { isSelectionSideChatThread } from "./selection-side-chat.js";
import { object, string, unsupported, type JsonObject } from "./json.js";
import { projectLegacySnapshot } from "./projection.js";
import { listSessionSubagents } from "./session-subagents.js";
import { listTargetedThreads } from "./thread-queries.js";
import {
  readControlModelSettings,
  type ControlModelThreadOverride,
} from "./control-presentation.js";
import { nativeProjectSource } from "./project-origin.js";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * 线程已生效的模型选择 → 控制面视图 override。线程还没有模型事实（新线程水合前）
 * 时保持全局 config 视图；不能把空字符串/非字符串脏值当成选择下发。
 */
function threadModelOverride(thread: JsonObject): ControlModelThreadOverride | undefined {
  const model = typeof thread.model === "string" ? thread.model.trim() : "";
  if (!model) return undefined;
  const modelProvider = typeof thread.modelProvider === "string" ? thread.modelProvider.trim() : "";
  const reasoningEffort =
    typeof thread.reasoningEffort === "string" ? thread.reasoningEffort.trim() : "";
  return {
    model,
    ...(modelProvider ? { modelProvider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export async function handleLegacySession(
  method: string,
  params: unknown,
  rpc: CodexRpcPort,
  store: ThreadStateStore,
  workspaceId: string,
): Promise<unknown> {
  const p = object(params ?? {});
  if (p.workspace && object(p.workspace).workspacePath !== store.cwd)
    throw new Error("Workspace mismatch");
  // task-index 按 workspaceIdentity 持久化；只改 workspaceKey 会把远端新会话
  // 写进本地路径分区。身份只取 Host 已授权的 workspaceId，不能从路径猜测远端。
  const workspace = {
    workspacePath: store.cwd,
    workspaceKey: workspaceId,
    ...(workspaceId !== store.cwd || object(p.workspace ?? {}).workspaceIdentity
      ? { workspaceIdentity: workspaceId }
      : {}),
  };
  if (method === "session/list") {
    const sessionIds =
      p.sessionIds === undefined
        ? undefined
        : z.array(z.string().trim().min(1)).min(1).max(64).parse(p.sessionIds);
    const threads = sessionIds
      ? await listTargetedThreads(rpc, store.cwd, sessionIds, (id) => store.get(id)?.thread)
      : await store.list();
    return {
      // 辅助对话 child 与任务列表同一隐藏规则（spec: codex-selection-side-chat）。
      sessions: threads
        .filter((thread) => !isSelectionSideChatThread(thread))
        .map((thread) => {
          const session = projectLegacySnapshot(thread, store.cwd).session;
          session.workspace = workspace;
          return session;
        }),
    };
  }
  // 子代理目录：子线程被 sourceKinds 挡在任务列表外，这是唯一按父查询子线程的入口。
  if (method === "session/subagents") return listSessionSubagents(p, rpc, store);
  let sessionId: string;
  if (method === "session/create") {
    const parsed = shared.codezSessionCreateParamsSchema.parse(p);
    if (parsed.additionalDirectories?.some((path) => !isAbsolute(path)) || !isAbsolute(store.cwd))
      throw new Error("Native workspace roots must be absolute");
    const thread = decorateNativeThread(
      await rpc.request("thread/start", {
        cwd: store.cwd,
        historyMode: "paginated",
        model: parsed.model?.modelId,
        modelProvider: parsed.model?.providerId,
        ...(parsed.additionalDirectories
          ? { runtimeWorkspaceRoots: [...new Set([store.cwd, ...parsed.additionalDirectories])] }
          : {}),
        ...(parsed.codexProjectId !== undefined
          ? { threadSource: nativeProjectSource(parsed.codexProjectId) }
          : {}),
      }),
    );
    store.markStarted(thread);
    sessionId = string(thread.id);
  } else sessionId = string(p.sessionId, "sessionId");
  const additionalDirectories =
    method === "session/resume" || method === "session/read"
      ? z.array(z.string().min(1)).max(256).optional().parse(p.additionalDirectories)
      : undefined;
  const state = await store.ensure(sessionId, additionalDirectories);
  const native = { threadId: sessionId };
  const controlContext = { rpc, cwd: store.cwd, auxiliary: { supports: () => false } };
  switch (method) {
    case "session/create":
    case "session/read":
    case "session/resume":
      break;
    case "session/messages": {
      const snapshot = projectLegacySnapshot(state.thread, store.cwd);
      return shared.codezSessionMessagesResultSchema.parse({ messages: snapshot.messages });
    }
    case "session/setModel": {
      const selection = shared.modelSelectionSchema.parse(p.model);
      // 跨 provider 换模型由 codex 原生按 catalog 路由；线程 provider 记录跟随选择。
      await rpc.request("thread/settings/update", { ...native, ...selectionOverrides(selection) });
      store.applySettings(sessionId, {
        ...selectionOverrides(selection),
        modelProvider: selection.providerId,
      });
      break;
    }
    case "session/setThoughtLevel":
      await rpc.request("thread/settings/update", { ...native, effort: p.thoughtLevel });
      store.applySettings(sessionId, { effort: p.thoughtLevel });
      break;
    case "session/setMode": {
      // 显式切换与 v4 sendText 同一迁移规则（specs/codex-permission-modes.md）。
      const mode = string(p.mode);
      const permissions = await turnPermissionIntent(controlContext, state.thread, mode);
      const settings = {
        ...native,
        ...turnMode(
          mode,
          string(state.thread.model),
          undefined,
          state.thread.reasoningEffort as string | undefined,
          permissions,
        ),
      };
      await rpc.request("thread/settings/update", settings);
      store.applySettings(sessionId, settings);
      store.rememberMode(sessionId, mode);
      break;
    }
    case "session/close":
      await rpc.request("thread/unsubscribe", native);
      // 桌面结果为 strict schema，额外 sessionId 会让成功卸载被误判为失败。
      return shared.codezSessionCloseResultSchema.parse({ closed: true });
    default:
      unsupported(method);
  }
  const snapshot = projectLegacySnapshot(state.thread, store.cwd);
  snapshot.session.workspace = workspace;
  // 修复根因：回包 settings 曾整体替换为全局 config 视图（config/read + model/list），
  // 把刚经 thread/settings/update 生效的线程级模型/档位覆盖回 config.toml 默认，
  // Bot（飞书/Telegram/微信）切模型后回包、任务索引回填与状态卡全部停在旧模型。
  // 目录与缺省档仍由全局视图提供；current 以线程状态（store.applySettings 后的真值）为准。
  snapshot.settings = await readControlModelSettings(
    controlContext,
    threadModelOverride(state.thread),
  );
  return shared.codezSessionStateSnapshotSchema.parse(snapshot);
}
