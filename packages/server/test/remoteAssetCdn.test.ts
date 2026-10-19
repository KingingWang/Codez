import { describe, expect, it } from "vitest";
import {
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@codez/server/remote/remoteAssetCdn.js";

describe("remoteAssetCdn URL encoding", () => {
  it("组件路径包含 '+' 时应编码为 %2B", () => {
    const urls = buildComponentArtifactUrlCandidates(
      ["https://cdn.example.com/codez/electron/releases/1.3.0"],
      "components/linux-arm64/server-bundle/v1.3.0+7138ea7a9b45.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/codez/electron/releases/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
      "https://cdn.example.com/codez/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("组件产物应从带版本 manifest 基址回退到跨版本 components 根目录", () => {
    const urls = buildComponentArtifactUrlCandidates(
      [
        "https://cdn.example.com/codez/electron/releases/1.3.0",
        "https://backup.example.com/codez/electron/releases/1.3.0",
      ],
      "components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/codez/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://cdn.example.com/codez/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/codez/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/codez/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
    ]);
  });

  it("已编码路径不应重复编码", () => {
    const urls = buildReleaseAssetUrlCandidates(
      ["https://cdn.example.com/codez/electron/releases/1.3.0"],
      ["components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz"],
    );

    expect(urls).toEqual([
      "https://cdn.example.com/codez/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("GitHub Release 下载根应保持精确 tag 根且不追加应用版本", () => {
    expect(
      buildReleaseBaseCandidates(
        ["https://github.com/KingingWang/Codez/releases/download/codez-build-1-0123456789ab"],
        "3.16.1",
      ),
    ).toEqual([
      "https://github.com/KingingWang/Codez/releases/download/codez-build-1-0123456789ab",
    ]);
  });
});
