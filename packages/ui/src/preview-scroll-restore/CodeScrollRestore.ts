import { useCallback, useState, type Ref, type UIEventHandler } from "react";
import { usePreviewScrollRestoreOrNull } from "./context.js";
import { useScrollRestoreBinding } from "./useScrollRestoreBinding.js";

function setOptionalRefValue<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

export interface CodeScrollRestoreProps {
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  /**
   * 关闭读位恢复。code-review 预览的落点由 focusRequestId 决定，
   * 恢复缓存会和定位滚动抢位置，因此那类 source 不参与恢复。
   */
  restoreEnabled?: boolean;
}

/**
 * 代码预览的读位接线：转接上游的 scrollContainerRef 以拿到真实滚动容器，
 * onScroll 原样透传（PreviewPane 仍用它维护折叠占位高度）。
 * 上游链路不改，这里只补「整棵预览子树被卸载后重新挂载」的场景，例如切换项目。
 */
export function useCodeScrollRestore({
  onScroll,
  scrollContainerRef,
  restoreEnabled = true,
}: CodeScrollRestoreProps): CodeScrollRestoreProps {
  const api = usePreviewScrollRestoreOrNull();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const handleScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      setOptionalRefValue(scrollContainerRef, node);
      setContainer(node);
    },
    [scrollContainerRef],
  );

  useScrollRestoreBinding({ api, container, restoreEnabled });

  if (!api || !restoreEnabled) {
    return { onScroll, scrollContainerRef, restoreEnabled };
  }
  return { onScroll, scrollContainerRef: handleScrollContainerRef, restoreEnabled };
}
