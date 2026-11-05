import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 观察兜底时限。Office / PPTX 正文解析可能很慢（大文件、首次加载渲染器 chunk），
 * 时限必须明显长于解析耗时，否则绑定建立不起来、读位静默丢失。
 * 没有容器的类型（Excel）由调用方直接不挂包装，不靠这个时限兜底；
 * 空闲的 MutationObserver 不产生回调，长时限本身没有成本。
 */
const DISCOVERY_TIMEOUT_MS = 60_000;

/**
 * 在 root 子树里找出真正的滚动容器。Office / PPTX 正文是 lazy + 异步解析的，
 * 挂载瞬间容器还不存在，因此先同步查一次，查不到就观察到出现为止。
 * rediscoverKey 变化（换 source）时重新发现，避免继续持有上一个文件的容器。
 */
export function useScrollRestoreContainer(
  rootRef: RefObject<HTMLElement | null>,
  selector: string,
  rediscoverKey: unknown,
): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    setContainer(null);
    if (!root) return;

    const found = root.querySelector<HTMLElement>(selector);
    if (found) {
      setContainer(found);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      const next = root.querySelector<HTMLElement>(selector);
      if (!next) return;
      setContainer(next);
      observer.disconnect();
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    observer.observe(root, { childList: true, subtree: true });
    timeoutId = setTimeout(() => observer.disconnect(), DISCOVERY_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [rediscoverKey, rootRef, selector]);

  return container;
}
