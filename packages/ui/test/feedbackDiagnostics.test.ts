import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEEDBACK_REPOSITORY_URL,
  MAX_FEEDBACK_PREFILLED_URL_LENGTH,
  buildFeedbackBody,
  buildFeedbackDiagnosticEntries,
  buildFeedbackIssueTitle,
  buildFeedbackPrefilledUrl,
} from "@/feedback/feedbackDiagnostics.js";

const DEVICE_SNAPSHOT = {
  appVersion: "3.15.1",
  buildCommitId: "872ad96",
  buildTime: "2026-10-15T00:00:00Z",
  nodeVersion: "v24.14.0",
  electronVersion: "38.0.0",
  osType: "Darwin",
  osPlatform: "darwin",
  osRelease: "24.6.0",
  osVersion: "24.6.0",
  osArch: "arm64",
  deviceMid: "SENTINEL-DEVICE-MID",
  hostname: "sentinel-host",
};

const FORBIDDEN_TOKENS = [
  "SENTINEL-DEVICE-MID",
  "sentinel-host",
  "deviceMid",
  "hostname",
  "user_id",
  "username",
];

describe("feedbackDiagnostics", () => {
  it("targets KingingWang/Codez GitHub repository", () => {
    expect(DEFAULT_FEEDBACK_REPOSITORY_URL).toBe("https://github.com/KingingWang/Codez");
  });

  it("includes only version and platform diagnostics and excludes device identity", () => {
    const entries = buildFeedbackDiagnosticEntries(
      { description: "崩溃了" },
      { device: DEVICE_SNAPSHOT },
    );
    const serialized = JSON.stringify(entries);

    for (const token of FORBIDDEN_TOKENS) {
      expect(serialized).not.toContain(token);
    }

    const app = entries.find((entry) => entry.id === "app");
    expect(app?.value).toContain("3.15.1");
    expect(app?.value).toContain("872ad96");

    const runtime = entries.find((entry) => entry.id === "runtime");
    expect(runtime?.value).toContain("macOS");
    expect(runtime?.value).toContain("arm64");
    expect(runtime?.value).toContain("Node v24.14.0");
  });

  it("maps platform identifiers to readable names and keeps unknown values", () => {
    expect(
      buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "win32" } })[1]?.value,
    ).toContain("Windows");
    expect(
      buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "linux" } })[1]?.value,
    ).toContain("Linux");
    expect(
      buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "plan9" } })[1]?.value,
    ).toContain("plan9");
  });

  it("builds a GitHub issues/new prefilled URL", () => {
    const url = buildFeedbackPrefilledUrl({
      title: "崩溃了",
      body: "诊断正文",
      locale: "zh-CN",
    });
    expect(url).toBeTruthy();
    expect(url?.startsWith(`${DEFAULT_FEEDBACK_REPOSITORY_URL}/issues/new?`)).toBe(true);
    expect(url).toContain("title=");
    expect(url).toContain("body=");
  });

  it("rejects empty, invalid, or non-http(s) repository URLs", () => {
    const cases = [
      "",
      "   ",
      "not a url",
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ];
    for (const repositoryUrl of cases) {
      expect(
        buildFeedbackPrefilledUrl({
          repositoryUrl,
          title: "t",
          body: "b",
          locale: "zh-CN",
        }),
      ).toBeNull();
    }
  });

  it("caps the first-line title at 80 characters and formats localized body", () => {
    expect(buildFeedbackIssueTitle("第一行\n第二行")).toBe("第一行");
    expect(buildFeedbackIssueTitle("   ")).toBe("");
    expect(buildFeedbackIssueTitle("x".repeat(200)).length).toBe(80);

    const zh = buildFeedbackBody([{ label: "app", value: "v1" }], {
      locale: "zh-CN",
      attachmentHint: "手动附加截图",
    });
    const en = buildFeedbackBody([{ label: "app", value: "v1" }], { locale: "en-US" });
    expect(zh).toContain("诊断信息");
    expect(zh).toContain("> 手动附加截图");
    expect(en).toContain("Diagnostics");
    expect(buildFeedbackBody([], { locale: "zh-CN" })).toBe("");
  });

  it("caps long URLs and appends a truncation notice", () => {
    const longBody = "错误行\n".repeat(3000);
    const url = buildFeedbackPrefilledUrl({
      title: "超长报错",
      body: longBody,
      locale: "zh-CN",
    });
    expect(url).toBeTruthy();
    expect(url!.length).toBeLessThanOrEqual(MAX_FEEDBACK_PREFILLED_URL_LENGTH);
    const decoded = decodeURIComponent(url!).replaceAll("+", " ");
    expect(decoded).toContain("预填内容因 URL 长度限制已截断");
  });
});
