import { useRef, type ReactNode } from "react";
import { usePreviewScrollRestore } from "./context.js";
import { useScrollRestoreBinding } from "./useScrollRestoreBinding.js";
import { useScrollRestoreContainer } from "./useScrollRestoreContainer.js";

const OFFICE_SCROLL_CONTAINER_SELECTOR = '[data-office-preview-scroll-container="true"]';

/**
 * DOCX / DOC 预览的读位恢复。正文由 lazy 组件异步解析渲染，容器出现时机不确定，
 * 因此走「观察到容器出现」的通用发现逻辑，上游只需在真实滚动容器上留一个标记。
 * Excel 是 canvas 网格，没有 DOM 读位，发现超时后自动退出，不参与恢复。
 */
export function OfficeScrollRestore({ children }: { children: ReactNode }) {
  const api = usePreviewScrollRestore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const container = useScrollRestoreContainer(rootRef, OFFICE_SCROLL_CONTAINER_SELECTOR, api);
  useScrollRestoreBinding({ api, container });

  return (
    <div ref={rootRef} className="h-full min-h-0">
      {children}
    </div>
  );
}
