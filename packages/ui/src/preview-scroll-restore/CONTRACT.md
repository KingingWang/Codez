# Preview scroll restore

Boundary 只保存当前 source 的 `scrollTop` 与 PDF 页码恢复缓存；Markdown DOM 和 PDF runtime 仍是唯一运行时状态 owner。缓存随 source key 变化重建，不持久化，不写入 task/session/Host/relay。

Markdown wrapper 复用现有 `data-markdown-preview` 滚动容器；PDF wrapper 通过既有 `PdfPreviewContent` 的恢复 props 传入初始页码并上报页码/滚动变化。上游预览组件只做最小接线，不承载第二份运行时状态。
