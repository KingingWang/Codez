import { lazy, Suspense } from "react";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import type { PptxElementReferenceSource } from "@/lib/pptxElementReference.js";
import type { PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";

const PptxPreviewViewer = lazy(() =>
  import("@/components/ui/pptx-preview-viewer.js").then((module) => ({
    default: module.PptxPreviewViewer,
  })),
);

export function PptxPreviewContent({
  data,
  fileName,
  initialPageNumber,
  labels,
  onOpenBrowserUrl,
  referenceSource,
  referenceNavigation,
  referenceNavigationReady,
}: {
  data: ArrayBuffer;
  labels: PptxPreviewViewerLabels;
  fileName?: string;
  /** 读位恢复用的一次性初始页码；不影响后续翻页的运行时归属。 */
  initialPageNumber?: number;
  referenceSource?: PptxElementReferenceSource;
  referenceNavigation?: PptxReferencePreviewNavigation;
  referenceNavigationReady?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PptxPreviewViewer
        data={data}
        fileName={fileName}
        initialPageNumber={initialPageNumber}
        labels={labels}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(referenceSource ? { referenceSource } : {})}
        {...(referenceNavigation ? { referenceNavigation } : {})}
        referenceNavigationReady={referenceNavigationReady}
        className="h-full"
      />
    </Suspense>
  );
}
