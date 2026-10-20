import { useMemo, useRef } from "react";
import { MarkdownSelectionTooltip } from "@/v4/MarkdownSelectionTooltip.js";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import type { Theme } from "@/useTheme.js";

interface MarkdownPreviewContentProps {
  content: string;
  sourceKey?: string;
  sourceTitle?: string;
  sourcePath?: string;
  selectionTarget?: MarkdownSelectionTarget;
  workspacePath?: string;
  /** 应用主题（store 耦合剥离）：透传给 markdown 渲染，缺省按 "system" 兜底。 */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：透传给 markdown 渲染，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  onOpenBrowserUrl?: (url: string) => void;
}

export function MarkdownPreviewContent({
  content,
  sourceKey,
  sourceTitle,
  sourcePath,
  selectionTarget,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenBrowserUrl,
}: MarkdownPreviewContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionScope = useMemo(
    () => ({}),
    [content, sourceKey, sourcePath, selectionTarget?.workspaceKey, selectionTarget?.sessionId],
  );
  // PreviewPane 渲染本地 md 文件时，相对路径图片应以 md 文件所在目录为基准解析，
  // 而不是以 workspace 根目录为基准。否则 md 文件不在 workspace 根目录时，
  // 类似 `./images/fig.png` 或 `images/fig.png` 的相对路径会拼错。
  const markdownBasePath = useMemo(() => {
    if (!sourcePath) return null;
    return getContainingDirectoryPath(sourcePath);
  }, [sourcePath]);
  const resolvedWorkspacePath = markdownBasePath ?? workspacePath;
  return (
    <div
      ref={rootRef}
      data-markdown-preview="true"
      className="w-full h-full bg-background overflow-auto"
    >
      {selectionTarget && sourceKey ? (
        <MarkdownSelectionTooltip
          scopeKey={selectionScope}
          rootRef={rootRef}
          sourceKey={sourceKey}
          sourceTitle={sourceTitle ?? sourceKey}
          sourcePath={sourcePath}
          target={selectionTarget}
        />
      ) : null}
      <div className="min-h-full bg-background p-4">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={resolvedWorkspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {content}
        </MessageResponse>
      </div>
    </div>
  );
}
