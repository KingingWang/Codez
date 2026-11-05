# Preview scroll restore

模块持有一份 renderer 内存级的读位快照表，按 `workspaceKey + sourceKey` 建条目，是「每个工作区每个预览源读到哪」的唯一 owner。快照必须跨 React 卸载存活：切换项目时侧栏 tab 按 `workspaceKey` 过滤，整棵 `FileManagerPane` 子树会被卸载，放在组件 ref 里的读位会直接丢失。表不落盘，不写入 task/session/Host/relay，超上限按最早写入淘汰。

`PreviewScrollRestoreBoundary` 只把当前 `(workspace, source)` 绑定到表中的一条，自身不缓存快照。同一次挂载内换 source 属于显式导航，boundary 在子树挂载前清空目标条目，保持上游「打开新文件从头开始」；卸载不清条目，因此切会话、切项目、关标签再回来都能恢复。boundary 也不重挂子树，避免换文件时把 `PreviewPane` 的视图模式等本地状态一起重置。

运行时状态仍分别归 `CodeViewer`、`MarkdownPreviewContent`、`PdfViewer`、`PptxPreviewViewer` 和 Office 渲染器；wrapper 只在滚动时写入快照、在重挂载时读回。各类型只在「怎么找到滚动容器」「有没有页码」上有差异，读写语义共用 `useScrollRestoreBinding`：

- 代码：`useCodeScrollRestore` 转接上游的 `onScroll` / `scrollContainerRef`，不改变 `PreviewPane` 既有的折叠占位逻辑；`code-review` 的落点归 `focusRequestId`，不参与恢复。
- Markdown / Office：复用本仓库自有的稳定 DOM 标记（`data-markdown-preview`、`data-office-preview-scroll-container`）。Office 正文是 lazy + 异步解析的，`useScrollRestoreContainer` 会观察到标记出现为止，观察时限必须明显长于最坏解析耗时，否则绑定建立不起来、读位会静默丢失；Excel 是 canvas 网格、没有 DOM 读位，由调用方直接不挂恢复包装。
- PDF / PPTX：页码由上游 viewer 的一次性初始页码入口负责（`initialPageNumber`），滚动位置由 wrapper 落位；页码回读走容器上的 `data-preview-page-number` / `data-pptx-page-number`。PPTX 带 `referenceNavigation` 时落点归引用跳转，恢复让位。

写入只由真实事件驱动（`scroll` 事件 + 页码属性变化），刻意不做卸载补写：换 source 后容器里可能还残留上一个文件的内容一帧，卸载补写会把旧读位写进新文件的条目。程序化归零与恢复期间同样抑制写入，避免自触发的 scroll 事件污染缓存。

上游预览组件只提供标记和一次性初始页码入口，不承载第二份运行时状态，也不得依赖第三方渲染器的私有 DOM。
