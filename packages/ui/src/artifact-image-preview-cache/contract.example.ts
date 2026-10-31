import type { ArtifactImagePreviewCache } from "./contract.js";

/** 命中方只消费 URL，不取得 revoke 所有权。 */
export function artifactImageCacheReadExample(cache: ArtifactImagePreviewCache) {
  return cache.getCachedArtifactImage("example-session", "codez-artifact://example-image");
}
