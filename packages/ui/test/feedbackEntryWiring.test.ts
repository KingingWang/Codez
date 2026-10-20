import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_FEEDBACK_REPOSITORY_URL } from "@/feedback/feedbackDiagnostics.js";
import {
  buildFeedbackEntryBody,
  buildFeedbackEntryDiagnostics,
  buildFeedbackEntryUrl,
  resolveFeedbackEntryTitle,
} from "@/feedback/feedbackEntryPlan.js";

const DEVICE_SNAPSHOT = {
  appVersion: "3.15.1",
  buildCommitId: "872ad96",
  buildTime: "2026-10-15T00:00:00Z",
  osPlatform: "darwin",
  osArch: "arm64",
  deviceMid: "SENTINEL-DEVICE-MID",
  hostname: "sentinel-host",
};

const FORBIDDEN_TOKENS = ["SENTINEL-DEVICE-MID", "sentinel-host", "deviceMid", "hostname"];

const CREDENTIAL_PAYLOADS: ReadonlyArray<{
  name: string;
  payload: string;
  secret: string;
}> = [
  {
    name: "Bearer JWT",
    payload:
      "请求失败 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  },
  {
    name: "URL query api_key",
    payload: "连接被拒绝 https://api.example.com/v1/chat?api_key=sk-live-51H8xQ2mNp7Rw9Tz",
    secret: "sk-live-51H8xQ2mNp7Rw9Tz",
  },
  {
    name: "password assignment",
    payload: "认证失败 password=hunter2",
    secret: "hunter2",
  },
  {
    name: "JSON token field",
    payload: '解析错误 {"token":"ghp_16C7e42F292c6912E7710c838347Ae178B4a"}',
    secret: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
  },
];

const formatMessage = (id: string): string => id;
const LOCALE = "zh-CN" as const;

function normalizeUrl(url: string | null): string {
  return decodeURIComponent(url ?? "").replaceAll("+", " ");
}

describe("feedbackEntryWiring", () => {
  it("routes entries to the GitHub issues/new prefilled URL with error summary in body", () => {
    const url = buildFeedbackEntryUrl({
      context: { errorSummary: "连接超时 ECONNRESET" },
      locale: LOCALE,
      formatMessage,
    });
    expect(url).toBeTruthy();
    expect(url?.startsWith(`${DEFAULT_FEEDBACK_REPOSITORY_URL}/issues/new?`)).toBe(true);
    expect(normalizeUrl(url)).toContain("连接超时 ECONNRESET");
  });

  it("builds a feature request prefilled URL with Feature request title prefix", () => {
    const url = buildFeedbackEntryUrl({
      context: { kind: "feature" },
      locale: LOCALE,
      formatMessage,
    });
    expect(url).toBeTruthy();
    const decoded = normalizeUrl(url);
    expect(decoded).toContain("Feature request:");
    expect(decoded).toContain("feedback.featureRequest.descriptionLabel");
    expect(decoded).toContain("feedback.featureRequest.solutionLabel");
  });

  it("redacts credentials across errorSummary, title, and description paths", () => {
    const paths: ReadonlyArray<{
      name: string;
      context: (payload: string) => Parameters<typeof buildFeedbackEntryUrl>[0]["context"];
    }> = [
      { name: "errorSummary", context: (payload) => ({ errorSummary: payload }) },
      { name: "title", context: (payload) => ({ title: payload, errorSummary: "占位" }) },
      { name: "description", context: (payload) => ({ description: payload }) },
    ];

    for (const { name, context } of paths) {
      for (const { name: payloadName, payload, secret } of CREDENTIAL_PAYLOADS) {
        const url = buildFeedbackEntryUrl({
          context: context(payload),
          locale: LOCALE,
          formatMessage,
        });
        expect(url, `${name}/${payloadName}`).toBeTruthy();
        expect(normalizeUrl(url)).not.toContain(secret);
      }
    }
  });

  it("keeps redaction idempotent and preserves version and platform diagnostics", () => {
    for (const { payload } of CREDENTIAL_PAYLOADS) {
      const once = buildFeedbackEntryBody({
        context: { description: payload },
        diagnosticFields: ["notes"],
        locale: LOCALE,
        formatMessage,
      });
      const twice = buildFeedbackEntryBody({
        context: { description: once.replace(/^###[^\n]*\n\n/, "").replace(/^- [^:]*: /, "") },
        diagnosticFields: ["notes"],
        locale: LOCALE,
        formatMessage,
      });
      expect(twice).toBe(once);
    }

    const url = buildFeedbackEntryUrl({
      context: { errorSummary: "崩溃了", description: "任务失败" },
      locale: LOCALE,
      formatMessage,
      runtime: { device: DEVICE_SNAPSHOT },
    });
    const decoded = normalizeUrl(url);
    for (const token of FORBIDDEN_TOKENS) {
      expect(decoded).not.toContain(token);
    }
    expect(decoded).toContain("3.15.1");
    expect(decoded).toContain("macOS");
    expect(decoded).toContain("崩溃了");
    expect(
      JSON.stringify(
        buildFeedbackEntryDiagnostics({ context: {}, runtime: { device: DEVICE_SNAPSHOT } }),
      ),
    ).not.toContain("SENTINEL-DEVICE-MID");
  });

  it("resolves title priority: explicit title > errorSummary first line > description first line", () => {
    expect(
      resolveFeedbackEntryTitle({ title: "显式标题", errorSummary: "错误", description: "描述" }),
    ).toBe("显式标题");
    expect(
      resolveFeedbackEntryTitle({ errorSummary: "错误首行\n错误次行", description: "描述首行" }),
    ).toBe("错误首行");
    expect(resolveFeedbackEntryTitle({ description: "描述首行\n描述次行" })).toBe("描述首行");
    expect(resolveFeedbackEntryTitle({ kind: "feature" })).toBe("Feature request: ");
    expect(resolveFeedbackEntryTitle({})).toBe("");
  });

  it("wires all UI feedback entry files to useFeedbackEntryAction instead of feedbackStore", () => {
    const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const wiredEntryFiles = [
      "ChatErrorBanner.tsx",
      "TaskListItem.tsx",
      "App.tsx",
      "WorkspaceHeaderSections.tsx",
      "WorkspaceHelpMenuButton.tsx",
      "WindowsCaptionMenuButton.tsx",
      "lib/helpMenuActions.ts",
      "remote-connection/RemoteConnectionConnectingStep.tsx",
      "v4/SessionSubscriptionErrorPanel.tsx",
      "workspace-grouped-tasks/task-row.tsx",
    ];

    for (const relativePath of wiredEntryFiles) {
      const source = readFileSync(join(uiSrc, relativePath), "utf8");
      expect(source, `${relativePath} should not call state.openSubmit`).not.toContain(
        "state.openSubmit",
      );
      expect(source, `${relativePath} should not call state.openFeatureRequest`).not.toContain(
        "state.openFeatureRequest",
      );
      expect(source, `${relativePath} should use runFeedbackEntry`).toContain("runFeedbackEntry");
    }
  });
});
