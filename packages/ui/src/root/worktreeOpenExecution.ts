import type { WorktreeOpenRoute } from "./worktreeOpenIntent.js";

/** root 的单一打开 admission；表单必须能等待并区分“创建完成 / 打开失败”。 */
export async function executeWorktreeOpenRoute({
  route,
  intent = "open",
  actions,
  inflight,
}: {
  route: WorktreeOpenRoute;
  intent?: "open" | "new-session";
  actions: {
    activate: (tabId: string) => void;
    startDraft: (tabId: string) => void;
    openLocal: (path: string) => Promise<void>;
    openRemote: (route: Extract<WorktreeOpenRoute, { kind: "open-remote" }>) => Promise<void>;
  };
  inflight: Map<string, Promise<void>>;
}): Promise<void> {
  if (route.kind === "unsupported") {
    throw new Error("Worktree open is unsupported");
  }
  if (route.kind === "activate") {
    actions.activate(route.tabId);
    if (intent === "new-session") actions.startDraft(route.tabId);
    return;
  }
  const key = route.kind === "open-local" ? route.workspacePath : route.workspaceIdentity;
  const existing = inflight.get(key);
  if (existing) return existing;
  // 原 Set 只拦截重复点击却无法返回结果，导致创建表单把未打开误判为成功。
  // 共享 Promise 保证单一路径 admission，并把失败原样交给步骤恢复。
  const operation = Promise.resolve().then(() =>
    route.kind === "open-local"
      ? actions.openLocal(route.workspacePath)
      : actions.openRemote(route),
  );
  inflight.set(key, operation);
  try {
    await operation;
  } finally {
    if (inflight.get(key) === operation) inflight.delete(key);
  }
}
