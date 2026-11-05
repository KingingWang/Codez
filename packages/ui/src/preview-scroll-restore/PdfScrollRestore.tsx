import { useMemo, useRef } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { usePreviewScrollRestore } from "./context.js";
import { useScrollRestoreBinding } from "./useScrollRestoreBinding.js";
import { useScrollRestoreContainer } from "./useScrollRestoreContainer.js";

const PDF_SCROLL_CONTAINER_SELECTOR = '[data-preview-scroll-container="true"]';
const PDF_PAGE_NUMBER_ATTRIBUTE = "data-preview-page-number";

export function PdfScrollRestore({
  source,
  labels,
}: {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
}) {
  const api = usePreviewScrollRestore();
  // 只在绑定变化时读一次：快照每次滚动都会被重写，若跟着变会让 pdf-viewer 的
  // [file, initialPageNumber, initialScrollTop] effect 反复复位页码和缩放。
  const snapshot = useMemo(() => api.getSnapshot(), [api]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const container = useScrollRestoreContainer(rootRef, PDF_SCROLL_CONTAINER_SELECTOR, api);
  useScrollRestoreBinding({
    api,
    container,
    pageNumberAttribute: PDF_PAGE_NUMBER_ATTRIBUTE,
  });

  return (
    <div ref={rootRef} className="h-full min-h-0">
      <PdfPreviewContent
        source={source}
        labels={labels}
        initialPageNumber={snapshot?.pageNumber}
        initialScrollTop={snapshot?.scrollTop}
      />
    </div>
  );
}
