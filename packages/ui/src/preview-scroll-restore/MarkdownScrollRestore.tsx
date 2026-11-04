import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePreviewScrollRestore } from "./context.js";

function restoreScrollWhenReady(container: HTMLElement, scrollTop: number): () => void {
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
  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
  };
}

export function MarkdownScrollRestore({ children }: { children: ReactNode }) {
  const api = usePreviewScrollRestore();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // 复用既有稳定 DOM 标记，不把滚动 ref 强行塞进上游 Markdown 组件。
    const container = root.querySelector<HTMLElement>('[data-markdown-preview="true"]');
    if (!container) return;

    const snapshot = api.getSnapshot();
    const cleanupRestore =
      snapshot && snapshot.scrollTop > 0
        ? restoreScrollWhenReady(container, snapshot.scrollTop)
        : undefined;
    const handleScroll = () => {
      api.saveSnapshot({ scrollTop: container.scrollTop });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      cleanupRestore?.();
      container.removeEventListener("scroll", handleScroll);
    };
  }, [api]);

  return (
    <div ref={rootRef} className="h-full min-h-0">
      {children}
    </div>
  );
}
