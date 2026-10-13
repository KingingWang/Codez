import type {
  WebRemoteControlAppPayload,
  WebRemoteControlTaskTarget,
} from "@codez/shared";

/**
 * 手机远控 app payload（bootstrap-response / workspace-list-response / workspace-list-updated）
 * 的明文 JSON 预算。
 *
 * Bugfix：2026-10-13 日志显示桌面把这些 payload 序列化到 1,054,465 字节，超过 relay 物理帧
 * 1MiB 硬上限（PROTOCOL_V4_LIMITS.maxFrameBytes），被 transport 整条拒发，手机因此永远收不到
 * bootstrap-response，表现为“桌面端响应超时”（desktop-bootstrap-timeout）。
 *
 * e2ee record 的密文是 base64(nonce + 明文 + tag)，外层的 relay data message 再加 envelope；
 * 700KiB 明文预算保证密封后仍低于 1MiB（与 WEB_REMOTE_CONTROL_E2EE_RPC_PHYSICAL_BUDGET
 * 同一姿势：为密文封套留足开销）。
 */
export const WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES = 700 * 1024;

/**
 * 手机任务列表只展示标题前两行；超长标题（完整 prompt / 日志被当成首条消息截进 title，
 * 真实数据里出现过 122KB 的单条标题）会把整个列表 payload 顶过物理帧上限。
 * 200 个字符对手机列表与标题展示已经足够。
 */
export const WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS = 200;

export interface WebRemoteControlPayloadBoundStats {
  /** 截断过标题的任务数。 */
  truncatedTitleCount: number;
  /** 因预算被丢弃的（最旧）任务数。 */
  droppedTaskCount: number;
  /** 截断标题后、丢弃任务前的 payload 明文字节数。 */
  bytesBeforeDrop: number;
  /** 最终 payload 明文字节数。 */
  bytesAfter: number;
}

export interface WebRemoteControlPayloadBoundResult {
  tasks: WebRemoteControlTaskTarget[];
  stats: WebRemoteControlPayloadBoundStats;
}

/**
 * 计量内部 app payload 的出站明文字节数。
 *
 * `codez_type` 与 wire 的 `zcode_type` 同为 10 个字符，内部 JSON 与 wire JSON 字节数一致，
 * 所以这里直接用内部 payload 计量即可代表最终 relay 明文大小（e2ee 密封前）。
 */
export function measureWebRemoteControlAppPayloadBytes(
  payload: WebRemoteControlAppPayload,
): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/**
 * 把任务列表约束进出站 payload 预算：
 * 1. 先把超长标题截到 `titleMaxChars`（保留全部任务）；
 * 2. 仍超预算时按调用方给定顺序丢弃尾部任务（调用方按 updatedAt 倒序传入，即先丢最旧）。
 *
 * 只改出站快照，不写回任何持久化或 renderer 状态。
 */
export function boundWebRemoteControlPayloadTasks(params: {
  tasks: readonly WebRemoteControlTaskTarget[];
  /** 以候选任务数组重建完整 app payload 并返回明文字节数。 */
  measureBytes: (tasks: WebRemoteControlTaskTarget[]) => number;
  budgetBytes?: number;
  titleMaxChars?: number;
}): WebRemoteControlPayloadBoundResult {
  const budgetBytes =
    params.budgetBytes ?? WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES;
  const titleMaxChars =
    params.titleMaxChars ?? WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS;

  let truncatedTitleCount = 0;
  const titled = params.tasks.map((task) => {
    if (task.title.length <= titleMaxChars) {
      return task;
    }
    truncatedTitleCount += 1;
    return { ...task, title: task.title.slice(0, titleMaxChars) };
  });

  const titledList = [...titled];
  const bytesBeforeDrop = params.measureBytes(titledList);
  if (bytesBeforeDrop <= budgetBytes) {
    return {
      tasks: titledList,
      stats: {
        truncatedTitleCount,
        droppedTaskCount: 0,
        bytesBeforeDrop,
        bytesAfter: bytesBeforeDrop,
      },
    };
  }

  // 标题截断后仍超预算：二分最大的可发送前缀。payload 字节数随前缀长度单调递增。
  let low = 0;
  let high = titledList.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (params.measureBytes(titledList.slice(0, mid + 1)) <= budgetBytes) {
      best = mid + 1;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const kept = titledList.slice(0, best);
  return {
    tasks: kept,
    stats: {
      truncatedTitleCount,
      droppedTaskCount: titledList.length - kept.length,
      bytesBeforeDrop,
      bytesAfter: params.measureBytes(kept),
    },
  };
}
