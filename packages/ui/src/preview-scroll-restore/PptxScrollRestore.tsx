import { useMemo, useRef, type ComponentProps } from "react";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { usePreviewScrollRestore } from "./context.js";
import { useScrollRestoreBinding } from "./useScrollRestoreBinding.js";
import { useScrollRestoreContainer } from "./useScrollRestoreContainer.js";

const PPTX_VIEWPORT_SELECTOR = '[data-pptx-preview-viewport="true"]';
const PPTX_PAGE_NUMBER_ATTRIBUTE = "data-pptx-page-number";

type PptxScrollRestoreProps = Omit<ComponentProps<typeof PptxPreviewContent>, "initialPageNumber">;

/**
 * PPTX 预览的读位恢复：页码交给上游 viewer 的一次性初始页码入口，滚动位置由这里落位。
 * 引用跳转（referenceNavigation）自己负责 goToPage 落点，恢复必须让位，否则会和它抢页码。
 */
export function PptxScrollRestore(props: PptxScrollRestoreProps) {
  const api = usePreviewScrollRestore();
  // 只在绑定变化时读一次，避免每次滚动重写快照导致初始页码 prop 抖动。
  const snapshot = useMemo(() => api.getSnapshot(), [api]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const restoreEnabled = !props.referenceNavigation;
  const container = useScrollRestoreContainer(rootRef, PPTX_VIEWPORT_SELECTOR, api);
  useScrollRestoreBinding({
    api,
    container,
    restoreEnabled,
    pageNumberAttribute: PPTX_PAGE_NUMBER_ATTRIBUTE,
  });
  const initialPageNumber = restoreEnabled ? snapshot?.pageNumber : undefined;

  return (
    <div ref={rootRef} className="h-full min-h-0">
      <PptxPreviewContent
        {...props}
        {...(initialPageNumber === undefined ? {} : { initialPageNumber })}
      />
    </div>
  );
}
