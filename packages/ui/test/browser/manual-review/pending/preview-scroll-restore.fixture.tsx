import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileBinaryPreview } from "@codez/shared";
import {
  MarkdownScrollRestore,
  OfficeScrollRestore,
  PdfScrollRestore,
  PreviewScrollRestoreBoundary,
  PptxScrollRestore,
  useCodeScrollRestore,
} from "@/preview-scroll-restore/index.js";
import { CodeContent } from "@/previewPaneCodeContent.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import paperUrl from "../../../../../../apps/codez-cli/packages/office-runtime/fixtures/paper.pdf?url";
import reportDocxUrl from "../../../../../../apps/codez-cli/packages/office-runtime/fixtures/report.docx?url";
import launchPptxUrl from "../../../../../../apps/codez-cli/packages/office-runtime/fixtures/launch.pptx?url";
import "@/styles.css";

type FixtureKind = "code" | "docx" | "markdown" | "pdf" | "pptx";

const params = new URLSearchParams(location.search);
const kindParam = params.get("kind");
const kind: FixtureKind =
  kindParam === "pdf" || kindParam === "code" || kindParam === "docx" || kindParam === "pptx"
    ? kindParam
    : "markdown";
const WORKSPACE_KEYS = ["ws-alpha", "ws-beta"] as const;
const SOURCES: Record<FixtureKind, ReadonlyArray<{ type: string; title: string; path: string }>> = {
  code: [
    { type: "file", title: "a.ts", path: "/src/a.ts" },
    { type: "file", title: "b.ts", path: "/src/b.ts" },
  ],
  docx: [
    { type: "file", title: "report.docx", path: "/docs/report.docx" },
    { type: "file", title: "other.docx", path: "/docs/other.docx" },
  ],
  markdown: [
    { type: "file", title: "a.md", path: "/docs/a.md" },
    { type: "file", title: "b.md", path: "/docs/b.md" },
  ],
  pdf: [
    { type: "pdf", title: "paper.pdf", path: "/paper.pdf" },
    { type: "pdf", title: "other.pdf", path: "/other.pdf" },
  ],
  pptx: [
    { type: "pptx", title: "launch.pptx", path: "/launch.pptx" },
    { type: "pptx", title: "other.pptx", path: "/other.pptx" },
  ],
};
const CODE_LINES = Array.from(
  { length: 400 },
  (_, index) => `export const line${index} = ${index};`,
).join("\n");
const pdfLabels = {
  loading: "Loading PDF…",
  loadError: "Failed to load PDF",
  noData: "No PDF",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageInput: "Page number",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
};
const pptxLabels: PptxPreviewViewerLabels = {
  loading: "Loading PPTX…",
  loadError: "Failed to load PPTX",
  noSlides: "No slides",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageInput: "Page number",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  thumbnails: "Thumbnails",
  thumbnail: (pageNumber) => `Slide ${pageNumber}`,
  exportPdf: "Export PDF",
  exportingPdf: "Exporting PDF…",
  exportPdfSuccess: (path) => `Exported ${path}`,
  exportPdfFailed: "Export failed",
  selectElement: "Select element",
  exitElementSelection: "Exit selection",
  aiEdit: "AI edit",
  commentPlaceholder: "Comment",
  cancelAiEdit: "Cancel",
  addToConversation: "Add to conversation",
  referencedPageMissing: (pageNumber) => `Slide ${pageNumber} is missing`,
  referencedSourceChanged: (pageNumber) => `Slide ${pageNumber} changed`,
};

function useArrayBuffer(url: string | null): ArrayBuffer | null {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void fetch(url)
      .then((response) => response.arrayBuffer())
      .then((data) => {
        if (!cancelled) setBuffer(data);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return buffer;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function CodePreviewBody() {
  // 复现上游接线：PreviewPaneContent 把 onScroll / scrollContainerRef 交给这层 hook 转接。
  const restored = useCodeScrollRestore({});
  return (
    <CodeContent
      code={CODE_LINES}
      language="typescript"
      codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
      codeTheme={DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme}
      wrapLongLines={false}
      onScroll={restored.onScroll}
      scrollContainerRef={restored.scrollContainerRef}
    />
  );
}

function DocxPreviewBody() {
  const buffer = useArrayBuffer(reportDocxUrl);
  const preview: FileBinaryPreview | null = buffer
    ? { path: "/docs/report.docx", dataBase64: toBase64(buffer), totalBytes: buffer.byteLength }
    : null;
  return (
    <OfficeScrollRestore>
      <PreviewPaneOfficeContent
        error={null}
        kind="docx"
        loading={!buffer}
        preview={preview}
        resolvedTheme="light"
        sourcePath="/docs/report.docx"
      />
    </OfficeScrollRestore>
  );
}

function PptxPreviewBody() {
  const buffer = useArrayBuffer(launchPptxUrl);
  if (!buffer) {
    return <div data-pptx-fixture-loading="true">Loading fixture…</div>;
  }
  return <PptxScrollRestore data={buffer} labels={pptxLabels} fileName="/launch.pptx" />;
}

function PreviewBody({ sourceIndex }: { sourceIndex: number }) {
  if (kind === "pdf") {
    // 真实预览里换 source 一定换文件；fixture 用查询参数制造不同的 pdf 文件身份，
    // 让 pdf-viewer 既有的 file effect 复位页码，而不是依赖外层重挂。
    const pdfSource = sourceIndex === 0 ? paperUrl : `${paperUrl}?alt=1`;
    return <PdfScrollRestore source={pdfSource} labels={pdfLabels} />;
  }
  if (kind === "code") {
    return <CodePreviewBody />;
  }
  if (kind === "docx") {
    return <DocxPreviewBody />;
  }
  if (kind === "pptx") {
    return <PptxPreviewBody />;
  }
  return (
    <MarkdownScrollRestore>
      <div
        data-markdown-preview="true"
        style={{ height: "100%", overflow: "auto", background: "white" }}
      >
        <div style={{ height: 2000 }}>
          {Array.from({ length: 100 }, (_, index) => (
            <p key={index}>Markdown line {index + 1}</p>
          ))}
        </div>
      </div>
    </MarkdownScrollRestore>
  );
}

function Fixture() {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const workspaceKey = WORKSPACE_KEYS[workspaceIndex];
  const source = SOURCES[kind][sourceIndex] ?? SOURCES[kind][0]!;
  return (
    <div style={{ height: 420, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" data-preview-toggle onClick={() => setVisible((value) => !value)}>
          Toggle preview
        </button>
        <button
          type="button"
          data-preview-switch-source
          onClick={() => setSourceIndex((value) => (value + 1) % SOURCES[kind].length)}
        >
          Switch source
        </button>
        <button
          type="button"
          data-preview-switch-workspace
          onClick={() => setWorkspaceIndex((value) => (value + 1) % WORKSPACE_KEYS.length)}
        >
          Switch workspace
        </button>
        <span data-preview-workspace={workspaceKey}>{workspaceKey}</span>
      </div>
      <div style={{ height: 320, minHeight: 0 }}>
        {/* key 模拟真实的切项目：另一个工作区的侧栏子树整体卸载后重新挂载。 */}
        <PreviewScrollRestoreBoundary
          key={workspaceKey}
          source={source}
          workspaceKey={workspaceKey}
        >
          {visible ? <PreviewBody sourceIndex={sourceIndex} /> : null}
        </PreviewScrollRestoreBoundary>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  // Office 预览组件通过 useCodezIntl 取文案，fixture 必须提供 intl 上下文。
  <CodezIntlProvider initialLocale="en-US">
    <Fixture />
  </CodezIntlProvider>,
);
