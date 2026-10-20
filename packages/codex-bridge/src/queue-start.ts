import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import { object, string } from "./json.js";

export async function startNativeQueuedSubmission(
  rpc: CodexRpcPort,
  store: ThreadStateStore,
  sessionId: string,
  queueItemId: string,
): Promise<void> {
  const response = await rpc.request("thread/queue/start", {
    threadId: sessionId,
    queuedSubmissionId: queueItemId,
  });
  store.acceptTurnResponse(sessionId, response);
  await store.refreshQueue(sessionId);
}

/** Bugfix：手机显式继续读取原生队首，不复制队列、不通过 turn/start 重发文本。 */
export async function resumeNativeQueue(
  rpc: CodexRpcPort,
  store: ThreadStateStore,
  sessionId: string,
): Promise<void> {
  await store.refreshQueue(sessionId);
  const head = store.get(sessionId)?.queue[0];
  if (head) await startNativeQueuedSubmission(rpc, store, sessionId, string(object(head).id));
}
