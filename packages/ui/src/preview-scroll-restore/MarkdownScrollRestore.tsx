import { useRef, type ReactNode } from "react";
import { usePreviewScrollRestore } from "./context.js";
import { useScrollRestoreBinding } from "./useScrollRestoreBinding.js";
import { useScrollRestoreContainer } from "./useScrollRestoreContainer.js";

const MARKDOWN_SCROLL_CONTAINER_SELECTOR = '[data-markdown-preview="true"]';

export function MarkdownScrollRestore({ children }: { children: ReactNode }) {
  const api = usePreviewScrollRestore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 复用既有稳定 DOM 标记，不把滚动 ref 强行塞进上游 Markdown 组件。
  const container = useScrollRestoreContainer(rootRef, MARKDOWN_SCROLL_CONTAINER_SELECTOR, api);
  useScrollRestoreBinding({ api, container });

  return (
    <div ref={rootRef} className="h-full min-h-0">
      {children}
    </div>
  );
}
