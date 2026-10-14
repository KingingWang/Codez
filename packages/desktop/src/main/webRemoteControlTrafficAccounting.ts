/**
 * 远控链路流量记账：按 app payload 类别聚合收发字节数，按周期输出摘要日志。
 *
 * 背景：手机远控用户报告静态查看会话时仍有持续高流量，但既有日志只能看到
 * "发生了哪些事件"，看不到每个类别的字节量，无法回答"流量到底是谁产生的"。
 * 该记账器只读 wire 字节数（发送侧取 transport 的精确计量，接收侧按同一计量函数估算），
 * 不触碰业务状态；摘要只含类别与字节数，不含任何业务内容。
 */

export interface WebRemoteControlTrafficBucket {
  count: number;
  bytes: number;
  maxBytes: number;
}

export interface WebRemoteControlTrafficWindow {
  totalCount: number;
  totalBytes: number;
  buckets: Record<string, WebRemoteControlTrafficBucket>;
}

export function createEmptyWebRemoteControlTrafficWindow(): WebRemoteControlTrafficWindow {
  return { totalCount: 0, totalBytes: 0, buckets: {} };
}

export function recordWebRemoteControlTraffic(
  window: WebRemoteControlTrafficWindow,
  category: string,
  bytes: number,
): void {
  const normalizedBytes = Math.max(0, Math.round(bytes));
  const bucket = (window.buckets[category] ??= { count: 0, bytes: 0, maxBytes: 0 });
  bucket.count += 1;
  bucket.bytes += normalizedBytes;
  bucket.maxBytes = Math.max(bucket.maxBytes, normalizedBytes);
  window.totalCount += 1;
  window.totalBytes += normalizedBytes;
}

/** 摘要只保留字节数最多的前几个类别，保证单行日志长度可控。 */
export function formatWebRemoteControlTrafficWindow(
  window: WebRemoteControlTrafficWindow,
  maxBuckets = 6,
): string {
  const top = Object.entries(window.buckets)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, maxBuckets)
    .map(([category, bucket]) => `${category}:${bucket.bytes}B x${bucket.count}`)
    .join(", ");
  return `total=${window.totalBytes}B x${window.totalCount}${top ? ` top=[${top}]` : ""}`;
}

export function isWebRemoteControlTrafficWindowEmpty(
  window: WebRemoteControlTrafficWindow,
): boolean {
  return window.totalCount === 0;
}
