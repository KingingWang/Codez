/** 兜底时限：内容始终撑不到目标高度时也必须停手，不能无限期抢滚动条。 */
const RESTORE_DEADLINE_MS = 6_000;
/**
 * 落位后再稳定观察一段：代码 / PDF / Office 正文是异步撑开的，渲染器可能在
 * 首次落位之后再次重排并把容器打回顶部。窗口过短会漏掉这次重排。
 */
const RESTORE_SETTLE_MS = 400;
/** 文件比目标位置短时的宽限期，等内容继续加载再决定是否停在底部。 */
const RESTORE_CLAMP_GRACE_MS = 500;
/** 纠正次数上限，避免和用户滚动长时间互相拉扯。 */
const RESTORE_MAX_CORRECTIONS = 60;

/**
 * 把容器滚动到目标读位。只在挂载瞬间设置一次会被尚未撑开的 scrollHeight 夹住，
 * 所以按帧重试直到落位并稳定；命中稳定窗口、宽限期或兜底时限后停止。
 */
export function restoreScrollWhenReady(
  container: HTMLElement,
  scrollTop: number,
  onSettled?: () => void,
): () => void {
  let stopped = false;
  let frameId = 0;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  let settledSince = 0;
  let clampedSince = 0;
  let corrections = 0;
  const startedAt = Date.now();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frameId);
    if (deadlineId !== undefined) clearTimeout(deadlineId);
    onSettled?.();
  };

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop > 0) {
      const target = Math.min(scrollTop, maxScrollTop);
      if (Math.abs(container.scrollTop - target) > 1) {
        container.scrollTop = target;
        corrections += 1;
        settledSince = 0;
        clampedSince = 0;
        if (corrections >= RESTORE_MAX_CORRECTIONS) {
          stop();
          return;
        }
      } else if (maxScrollTop >= scrollTop) {
        settledSince = settledSince || now;
        clampedSince = 0;
        if (now - settledSince >= RESTORE_SETTLE_MS) {
          stop();
          return;
        }
      } else {
        // 目标读位超出内容高度，只能停在底部；给一段宽限期等内容继续加载。
        clampedSince = clampedSince || now;
        settledSince = 0;
        if (now - clampedSince >= RESTORE_CLAMP_GRACE_MS) {
          stop();
          return;
        }
      }
    }
    if (now - startedAt >= RESTORE_DEADLINE_MS) {
      stop();
      return;
    }
    frameId = requestAnimationFrame(tick);
  };

  frameId = requestAnimationFrame(tick);
  deadlineId = setTimeout(stop, RESTORE_DEADLINE_MS);
  return stop;
}
