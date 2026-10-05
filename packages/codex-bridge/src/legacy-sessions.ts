import * as shared from "@codez/shared";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import { decorateNativeThread, selectionOverrides, turnMode } from "./command-input.js";
import { turnPermissionIntent } from "./control-common.js";
import { isSelectionSideChatThread } from "./selection-side-chat.js";
import { object, string, unsupported } from "./json.js";
import { projectLegacySnapshot } from "./projection.js";
import { readControlModelSettings } from "./control-presentation.js";

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
    return {
      // 辅助对话 child 与任务列表同一隐藏规则（spec: codex-selection-side-chat）。
      sessions: (await store.list())
        .filter((thread) => !isSelectionSideChatThread(thread))
        .map((thread) => {
          const session = projectLegacySnapshot(thread, store.cwd).session;
          session.workspace = workspace;
          return session;
        }),
    };
  }
  let sessionId: string;
  if (method === "session/create") {
    const parsed = shared.codezSessionCreateParamsSchema.parse(p);
    const thread = decorateNativeThread(
      await rpc.request("thread/start", {
        cwd: store.cwd,
        historyMode: "paginated",
        model: parsed.model?.modelId,
        modelProvider: parsed.model?.providerId,
      }),
    );
    store.markStarted(thread);
    sessionId = string(thread.id);
  } else sessionId = string(p.sessionId, "sessionId");
  const state = await store.ensure(sessionId);
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
  snapshot.settings = await readControlModelSettings(controlContext);
  return shared.codezSessionStateSnapshotSchema.parse(snapshot);
}
