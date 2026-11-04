import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MarkdownScrollRestore,
  PdfScrollRestore,
  PreviewScrollRestoreBoundary,
} from "@/preview-scroll-restore/index.js";
import paperUrl from "../../../../../../apps/codez-cli/packages/office-runtime/fixtures/paper.pdf?url";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") === "pdf" ? "pdf" : "markdown";
const initialSource =
  kind === "pdf"
    ? { type: "pdf", title: "paper.pdf", path: "/paper.pdf" }
    : { type: "file", title: "a.md", path: "/docs/a.md" };
const nextSource =
  kind === "pdf"
    ? { type: "pdf", title: "other.pdf", path: "/other.pdf" }
    : { type: "file", title: "b.md", path: "/docs/b.md" };
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

function Fixture() {
  const [source, setSource] = useState(initialSource);
  const [visible, setVisible] = useState(true);
  return (
    <div style={{ height: 420, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" data-preview-toggle onClick={() => setVisible((value) => !value)}>
          Toggle preview
        </button>
        <button type="button" data-preview-switch-source onClick={() => setSource(nextSource)}>
          Switch source
        </button>
      </div>
      <div style={{ height: 160, minHeight: 0 }}>
        <PreviewScrollRestoreBoundary source={source}>
          {visible ? (
            kind === "pdf" ? (
              <PdfScrollRestore source={paperUrl} labels={pdfLabels} />
            ) : (
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
            )
          ) : null}
        </PreviewScrollRestoreBoundary>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
