import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexGitHubUpdateFeedOptions } from "../src/main/desktopProductRuntime.js";

// 回归：setFeedURL 会直接安装 GitHub provider，electron-updater 不再回读 app-update.yml
// 烘焙的 channel；channel 缺省静默回退 "latest"，请求 latest-mac.yml 命中 404，
// 因为 release 只发布 per-arch yml（见 specs/codex-desktop-distribution.md）。
// feed options 必须始终携带 per-arch channel，名字与发布资产的命名规则一一对应。
test("codex github feed pins per-arch channel matching release metadata names", () => {
  assert.deepEqual(resolveCodexGitHubUpdateFeedOptions("x64"), {
    provider: "github",
    owner: "KingingWang",
    repo: "Codez",
    channel: "x64-latest",
  });
  assert.deepEqual(resolveCodexGitHubUpdateFeedOptions("arm64"), {
    provider: "github",
    owner: "KingingWang",
    repo: "Codez",
    channel: "arm64-latest",
  });
});
