/**
 * 首次配对的页面可见期定时器；transport 决定何时暂停、重启或完成，
 * 这里不持有 relay/任务状态，也不改变已配对后的恢复路径。
 */
export function createInitialPairingDeadline(timeoutMs: number | undefined, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const pause = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    reset() {
      pause();
      completed = false;
    },
    arm() {
      if (completed || timer || timeoutMs === undefined || timeoutMs <= 0) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!completed) onTimeout();
      }, timeoutMs);
    },
    pause,
    complete() {
      completed = true;
      pause();
    },
  };
}
