/** 预览恢复缓存使用的最小 source 形状；不复制 CodeViewerSource 的完整联合类型。 */
export interface PreviewScrollRestoreSource {
  readonly type: string;
  readonly title: string;
  readonly path?: string;
}

/** 仅保存重挂载后需要恢复的读位，不保存运行时渲染状态。 */
export interface PreviewScrollRestoreSnapshot {
  readonly scrollTop: number;
  readonly pageNumber?: number;
}

/** Boundary 是恢复缓存 owner；真实滚动/页码运行态仍由具体预览组件持有。 */
export interface PreviewScrollRestoreApi {
  getSnapshot(): PreviewScrollRestoreSnapshot | null;
  saveSnapshot(snapshot: PreviewScrollRestoreSnapshot): void;
  clearSnapshot(): void;
}
