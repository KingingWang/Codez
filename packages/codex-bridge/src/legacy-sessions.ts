import * as shared from "@zcode/shared";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import { decorateNativeThread, selectionOverrides, turnMode } from "./command-input.js";
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
  if (method === "session/list") {
    return {
      sessions: (await store.list()).map((thread) => {
        const session = projectLegacySnapshot(thread, store.cwd).session;
        session.workspace.workspaceKey = workspaceId;
        return session;
      }),
    };
  }
  let sessionId: string;
  if (method === "session/create") {
    const parsed = shared.zcodeSessionCreateParamsSchema.parse(p);
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
  switch (method) {
    case "session/create":
    case "session/read":
    case "session/resume":
      break;
    case "session/messages": {
      const snapshot = projectLegacySnapshot(state.thread, store.cwd);
      return shared.zcodeSessionMessagesResultSchema.parse({ messages: snapshot.messages });
    }
    case "session/setModel": {
      const selection = shared.modelSelectionSchema.parse(p.model);
      if (selection.providerId !== state.thread.modelProvider)
        unsupported("provider changes within a thread");
      await rpc.request("thread/settings/update", { ...native, ...selectionOverrides(selection) });
      store.applySettings(sessionId, selectionOverrides(selection));
      break;
    }
    case "session/setThoughtLevel":
      await rpc.request("thread/settings/update", { ...native, effort: p.thoughtLevel });
      store.applySettings(sessionId, { effort: p.thoughtLevel });
      break;
    case "session/setMode": {
      const settings = {
        ...native,
        ...turnMode(
          string(p.mode),
          string(state.thread.model),
          undefined,
          state.thread.reasoningEffort as string | undefined,
          state.thread.sandboxPolicy,
          true,
        ),
      };
      await rpc.request("thread/settings/update", settings);
      store.applySettings(sessionId, settings);
      break;
    }
    case "session/close":
      await rpc.request("thread/unsubscribe", native);
      // 桌面结果为 strict schema，额外 sessionId 会让成功卸载被误判为失败。
      return shared.zcodeSessionCloseResultSchema.parse({ closed: true });
    default:
      unsupported(method);
  }
  const snapshot = projectLegacySnapshot(state.thread, store.cwd);
  snapshot.session.workspace.workspaceKey = workspaceId;
  snapshot.settings = await readControlModelSettings({ rpc, cwd: store.cwd });
  return shared.zcodeSessionStateSnapshotSchema.parse(snapshot);
}
