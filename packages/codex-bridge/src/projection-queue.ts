import { queueStateSchema, type QueueItem, type QueueState } from "@codez/shared/codez-protocol-v4";
import {
  codexQueueListSchema,
  codexQueuedSubmissionSchema,
  type CodexQueueList,
} from "./codex-types.js";
import { projectInputText } from "./projection-rows.js";

/** Existing command-correlation facts, supplied by the caller; never stored here.
 * Native queue/list does not contain these facts. Do not derive admission from list position/time.
 */
export type QueueAdmissionFacts = Pick<QueueItem, "clientId" | "admittedAt" | "order">;

/** A lossless, validated native page for native queue presentation, including pagination. */
export function projectCodexQueue(queue: unknown): CodexQueueList {
  const page = Array.isArray(queue)
    ? { data: codexQueuedSubmissionSchema.array().parse(queue), nextCursor: null }
    : codexQueueListSchema.parse(queue);
  const ids = page.data.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate Codex queued submission ID");
  return page;
}

/** V4 requires admission fields that the native response does not provide. External/recovered
 * submissions use explicit unavailable sentinels: clientId=codex-external, admittedAt=0,
 * admissionSeq=0. These are not measured facts and must not establish admission ordering.
 * queuePosition alone follows the native list. No shadow queue or ledger is retained here.
 * autoDrain controls stay unavailable: false is a disabled UI value,
 * not a claim that Codex implements the Codez pause/auto-drain contract.
 */
export function projectQueue(
  queue: unknown,
  admissions: Readonly<Record<string, QueueAdmissionFacts>> = {},
): QueueState {
  const page = projectCodexQueue(queue);
  if (page.nextCursor !== null) throw new Error("Codex queue projection requires all pages");
  const items = page.data.map((submission, queuePosition): QueueItem => {
    const facts = Object.hasOwn(admissions, submission.id) ? admissions[submission.id] : undefined;
    return {
      sourceCommandId: submission.clientUserMessageId,
      queueItemId: submission.id,
      // 外部 Codex 客户端/重启后无 bridge ledger；保留原生队列，以零表示时间/序号不可用。
      clientId: facts?.clientId ?? "codex-external",
      kind: "sendText",
      text: projectInputText(submission.input),
      attachments: [],
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: facts?.order.admissionSeq ?? 0, queuePosition },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: facts?.admittedAt ?? 0,
    };
  });
  return queueStateSchema.parse({ items, autoDrain: false });
}
