import { useLayoutEffect } from "react";
import type { PreviewScrollRestoreApi, PreviewScrollRestoreSnapshot } from "./contract.js";
import { restoreScrollWhenReady } from "./restoreScrollWhenReady.js";

function readPageNumber(container: HTMLElement, attribute: string): number | undefined {
  const rawPageNumber = container.getAttribute(attribute);
  const pageNumber = Number.parseInt(rawPageNumber ?? "", 10);
  return Number.isFinite(pageNumber) ? pageNumber : undefined;
}

/**
 * 把滚动容器接到恢复缓存上：滚动即写缓存，重挂载即恢复，没有缓存条目时归零。
 * 各预览类型只在「怎么找到容器」「有没有页码」上有差异，读写语义共用这一份。
 *
 * 写入只由真实事件驱动（scroll 事件 + 页码属性变化），不做卸载补写：
 * 换 source 时容器里短暂还是上一个文件的内容，卸载补写会把旧文件的读位
 * 写进新文件的缓存条目。程序化归零/恢复期间同样抑制写入，避免自触发污染。
 */
export function useScrollRestoreBinding({
  api,
  container,
  restoreEnabled = true,
  pageNumberAttribute,
}: {
  api: PreviewScrollRestoreApi | null;
  container: HTMLElement | null;
  /** 落点由别的机制负责时（code-review 定位、pptx 引用跳转）关闭恢复，避免抢滚动条。 */
  restoreEnabled?: boolean;
  pageNumberAttribute?: string;
}): void {
  useLayoutEffect(() => {
    if (!api || !container || !restoreEnabled) return;

    let suppressSave = true;
    let releaseFrameId = 0;
    const releaseSave = () => {
      cancelAnimationFrame(releaseFrameId);
      releaseFrameId = requestAnimationFrame(() => {
        suppressSave = false;
      });
    };
    const readSnapshot = (): PreviewScrollRestoreSnapshot => ({
      scrollTop: container.scrollTop,
      ...(pageNumberAttribute
        ? { pageNumber: readPageNumber(container, pageNumberAttribute) }
        : {}),
    });
    const saveSnapshot = () => {
      if (suppressSave) return;
      api.saveSnapshot(readSnapshot());
    };

    const snapshot = api.getSnapshot();
    const stopRestore =
      snapshot && snapshot.scrollTop > 0
        ? restoreScrollWhenReady(container, snapshot.scrollTop, releaseSave)
        : undefined;
    if (!stopRestore) {
      if (!snapshot) {
        // 没有缓存条目说明这是显式导航到新文件；滚动容器 DOM 会被复用，必须主动归零。
        container.scrollTop = 0;
      }
      releaseSave();
    }

    container.addEventListener("scroll", saveSnapshot, { passive: true });
    // 翻页不一定产生滚动事件（容器本来就在顶部时 scrollTop 不变），页码要单独观察。
    let pageObserver: MutationObserver | undefined;
    if (pageNumberAttribute) {
      pageObserver = new MutationObserver(saveSnapshot);
      pageObserver.observe(container, {
        attributes: true,
        attributeFilter: [pageNumberAttribute],
      });
    }

    return () => {
      stopRestore?.();
      cancelAnimationFrame(releaseFrameId);
      container.removeEventListener("scroll", saveSnapshot);
      pageObserver?.disconnect();
    };
  }, [api, container, pageNumberAttribute, restoreEnabled]);
}
