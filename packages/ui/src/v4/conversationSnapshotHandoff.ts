// 跨 React 树重挂的会话快照交接缓存。
//
// Bug 背景（手机远控线上日志实测）：bridge 因 replay buffer 超限降级后，手机端
// 恢复链路会重建 bridge 并以新 key 整体重挂 Root，SessionDataLayer 与投影 store
// 随之销毁重建。新 store 从 0 全量订阅，几百条消息的会话首帧就达数 MB；
// 移动链路的 ACK 排空速度远低于突发产生速度，于是再次打爆 replay buffer，
// 形成「降级 → 重挂 → 全量重订阅 → 再降级」的永久循环——既表现为持续高带宽，
// 也让会话页永远停在 loading 转圈。
//
// 这里把最近一次完整应用的快照按 topic 暂存：重挂后的新 store 以它为 subscribe
// base（CLI 按 logEpoch+seq 裁决 resume/snapshot，协议侧已有完整裁决与兜底），
// 恢复只需增量帧，且缓存内容在 ACK 到达前立即可见，打破上述循环。
//
// 一致性不变量与 store 的三条规则一致：快照仅在完整应用后写入，本身是
// seq 时刻的一致投影；base 与状态同生共死，CLI 拒绝 base 时发全量快照整体替换。
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";

/** 交接条目保鲜期：bridge 重建发生在秒级；超过 30 分钟的旧快照宁可全量重拉。 */
const HANDOFF_TTL_MS = 30 * 60 * 1000;
/** 最多保留的 topic 数：手机同时只看一个会话，桌面保留最近两个以覆盖来回切换。 */
const HANDOFF_MAX_ENTRIES = 2;

interface ConversationSnapshotHandoffEntry {
  snapshot: ConversationSnapshot;
  savedAt: number;
}

const handoffByTopic = new Map<string, ConversationSnapshotHandoffEntry>();

/** store close 时写入。snapshot 是不可变结构共享对象，直接引用即可，不做拷贝。 */
export function writeConversationSnapshotHandoff(
  topic: string,
  snapshot: ConversationSnapshot,
  now: number = Date.now(),
): void {
  handoffByTopic.delete(topic);
  handoffByTopic.set(topic, { snapshot, savedAt: now });
  while (handoffByTopic.size > HANDOFF_MAX_ENTRIES) {
    const oldest = handoffByTopic.keys().next().value;
    if (oldest === undefined) break;
    handoffByTopic.delete(oldest);
  }
}

/** 新 store 构造时取走（单消费者）：同一 topic 的后续重建由新 store 的 close 再写回。 */
export function takeConversationSnapshotHandoff(
  topic: string,
  now: number = Date.now(),
): ConversationSnapshot | null {
  const entry = handoffByTopic.get(topic);
  if (!entry) return null;
  handoffByTopic.delete(topic);
  if (now - entry.savedAt > HANDOFF_TTL_MS) return null;
  return entry.snapshot;
}

/** 测试用：清空交接缓存。 */
export function clearConversationSnapshotHandoffs(): void {
  handoffByTopic.clear();
}
