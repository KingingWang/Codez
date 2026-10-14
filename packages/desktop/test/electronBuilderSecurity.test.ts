import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  // 本文件验证两种产品共用的 Electron fuse；明确 legacy，避免配置单测
  // 默认进入 Codex 制品校验并依赖本机不存在的跨平台 bridge/远程归档。
  vi.stubEnv("CODEZ_DESKTOP_RUNTIME", "legacy");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("Windows 打包关闭 Node Inspector，保留 Agent 所需的 RunAsNode", async () => {
  vi.stubEnv("CODEZ_TARGET_OS", "win32");
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses?.enableNodeCliInspectArguments).toBe(false);
  expect(config.electronFuses?.runAsNode).toBeUndefined();
});

it.each(["darwin", "linux"])("%s 保留现有 fuse 配置", async (platform) => {
  vi.stubEnv("CODEZ_TARGET_OS", platform);
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses).toBeUndefined();
});
