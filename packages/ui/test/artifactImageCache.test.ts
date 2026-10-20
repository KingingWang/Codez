// artifact 图片预览缓存：命中后不再走 attachmentReadV4，逐出时回收 objectURL。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheArtifactImage,
  clearArtifactImageCache,
  getCachedArtifactImage,
} from "@/components/ai-elements/artifactImageCache.js";

describe("artifactImageCache", () => {
  beforeEach(() => {
    let counter = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:mock-${++counter}`),
      revokeObjectURL: vi.fn(),
    });
    clearArtifactImageCache();
  });

  afterEach(() => {
    clearArtifactImageCache();
    vi.unstubAllGlobals();
  });

  it("写入后命中，未命中返回 null", () => {
    cacheArtifactImage("s1", "codez-artifact://a", {
      objectUrl: "blob:1",
      mediaType: "image/png",
      byteLength: 10,
    });
    expect(getCachedArtifactImage("s1", "codez-artifact://a")?.objectUrl).toBe("blob:1");
    expect(getCachedArtifactImage("s1", "codez-artifact://b")).toBeNull();
    expect(getCachedArtifactImage("s2", "codez-artifact://a")).toBeNull();
  });

  it("超过条目上限时按 LRU 逐出并回收 objectURL", () => {
    vi.useFakeTimers();
    let now = 1_000;
    vi.setSystemTime(now);
    for (let index = 0; index < 24; index += 1) {
      cacheArtifactImage("s1", `ref-${index}`, {
        objectUrl: `blob:${index}`,
        mediaType: "image/png",
        byteLength: 100,
      });
      vi.setSystemTime((now += 1));
    }
    // 触碰 ref-0 使其成为最近使用，之后插入第 25 条应逐出 ref-1。
    expect(getCachedArtifactImage("s1", "ref-0")).not.toBeNull();
    vi.setSystemTime((now += 1));
    cacheArtifactImage("s1", "ref-24", {
      objectUrl: "blob:24",
      mediaType: "image/png",
      byteLength: 100,
    });
    expect(getCachedArtifactImage("s1", "ref-1")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(getCachedArtifactImage("s1", "ref-0")).not.toBeNull();
    expect(getCachedArtifactImage("s1", "ref-24")).not.toBeNull();
    vi.useRealTimers();
  });

  it("同 key 覆盖写入时回收旧 objectURL", () => {
    cacheArtifactImage("s1", "ref", {
      objectUrl: "blob:old",
      mediaType: "image/png",
      byteLength: 10,
    });
    cacheArtifactImage("s1", "ref", {
      objectUrl: "blob:new",
      mediaType: "image/png",
      byteLength: 10,
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old");
    expect(getCachedArtifactImage("s1", "ref")?.objectUrl).toBe("blob:new");
  });
});
