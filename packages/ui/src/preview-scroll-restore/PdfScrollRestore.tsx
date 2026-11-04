import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { usePreviewScrollRestore } from "./context.js";

function restorePdfScrollWhenReady(container: HTMLDivElement, scrollTop: number): () => void {
  let restored = false;
  const apply = () => {
    if (restored) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop <= 0) return;
    container.scrollTop = Math.min(scrollTop, maxScrollTop);
    restored = true;
  };

  const frameId = requestAnimationFrame(apply);
  const observer = new ResizeObserver(apply);
  observer.observe(container);
  const content = container.firstElementChild;
  if (content) observer.observe(content);
  const mutationObserver = new MutationObserver(apply);
  mutationObserver.observe(container, { childList: true, subtree: true });
  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    mutationObserver.disconnect();
  };
}

export function PdfScrollRestore({
  source,
  labels,
}: {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
}) {
  const api = usePreviewScrollRestore();
  const snapshot = api.getSnapshot();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);

  const handleScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainer(node);
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainer;
    const restoreScrollTop = snapshot?.scrollTop ?? 0;
    if (!container || restoreScrollTop <= 0) return;
    return restorePdfScrollWhenReady(container, restoreScrollTop);
  }, [snapshot, scrollContainer]);

  useEffect(() => {
    if (!scrollContainer) return;
    const readPageNumber = () => {
      const rawPageNumber = scrollContainer.getAttribute("data-preview-page-number");
      const pageNumber = Number.parseInt(rawPageNumber ?? "", 10);
      return Number.isFinite(pageNumber) ? pageNumber : undefined;
    };
    const saveSnapshot = () => {
      api.saveSnapshot({
        scrollTop: scrollContainer.scrollTop,
        pageNumber: readPageNumber(),
      });
    };
    const handleScroll = () => {
      saveSnapshot();
    };
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      const previousSnapshot = api.getSnapshot();
      api.saveSnapshot({
        scrollTop:
          scrollContainer.scrollTop > 0
            ? scrollContainer.scrollTop
            : (previousSnapshot?.scrollTop ?? 0),
        pageNumber: readPageNumber(),
      });
    };
  }, [api, scrollContainer]);

  return (
    <PdfPreviewContent
      source={source}
      labels={labels}
      initialPageNumber={snapshot?.pageNumber}
      initialScrollTop={snapshot?.scrollTop}
      scrollContainerRef={handleScrollContainerRef}
    />
  );
}
