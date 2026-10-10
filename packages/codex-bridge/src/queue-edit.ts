import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import { replaceQueuedText, type ResolveAttachments } from "./command-input.js";

/** Queue ownership stays native; update must read the fresh authoritative submission first. */
export async function editQueuedInput(
  rpc: CodexRpcPort,
  store: ThreadStateStore,
  sessionId: string,
  edit: { queueItemId: string; newText: string },
  attachments?: ResolveAttachments,
): Promise<void> {
  await store.refreshQueue(sessionId);
  const state = store.get(sessionId);
  if (!state) throw new Error("Queue changed before editing");
  const input = await replaceQueuedText(
    state.queue,
    edit.queueItemId,
    edit.newText,
    sessionId,
    attachments,
  );
  await rpc.request("thread/queue/update", {
    threadId: sessionId,
    queuedSubmissionId: edit.queueItemId,
    input,
  });
  await store.refreshQueue(sessionId);
}
