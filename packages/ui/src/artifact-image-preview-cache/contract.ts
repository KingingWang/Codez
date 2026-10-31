export interface ArtifactImagePreview {
  readonly objectUrl: string;
  readonly mediaType: string;
}

/** 与原 artifactImageCache 三个导出完全相同的浏览器资源端口。 */
export interface ArtifactImagePreviewCache {
  getCachedArtifactImage(sessionId: string, ref: string): ArtifactImagePreview | null;
  cacheArtifactImage(
    sessionId: string,
    ref: string,
    entry: ArtifactImagePreview & { readonly byteLength: number },
  ): void;
  clearArtifactImageCache(): void;
}
