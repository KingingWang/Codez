import { describe, expect, it } from "vitest";
import {
  parseCodezBackgroundTaskNotificationText,
  codezBackgroundTaskNotificationToolUpdateStatus,
} from "../src/background-task-notifications.js";

describe("background task notifications", () => {
  it("preserves stopped task-notification status and normalizes killed to stopped", () => {
    expect(codezBackgroundTaskNotificationToolUpdateStatus("stopped")).toBe("stopped");
    expect(codezBackgroundTaskNotificationToolUpdateStatus("killed")).toBe("stopped");
  });

  it("normalizes terminal task-notification status", () => {
    expect(codezBackgroundTaskNotificationToolUpdateStatus("completed")).toBe("completed");
    expect(codezBackgroundTaskNotificationToolUpdateStatus("failed")).toBe("failed");
    expect(codezBackgroundTaskNotificationToolUpdateStatus("lost")).toBe("failed");
    expect(codezBackgroundTaskNotificationToolUpdateStatus("unexpected")).toBe("completed");
    expect(codezBackgroundTaskNotificationToolUpdateStatus(undefined)).toBe("completed");
  });

  it("parses failed notification error and decodes XML entities exactly once", () => {
    const providerMessage = "429 & retry; literal &amp; marker";
    const summary = `Agent general-purpose task "Review" failed. ${providerMessage}`;
    const parsed = parseCodezBackgroundTaskNotificationText(
      [
        "<task-notification>",
        "<task-id>agent_429</task-id>",
        "<tool-use-id>toolu_429</tool-use-id>",
        "<status>failed</status>",
        "<summary>Agent general-purpose task &quot;Review&quot; failed. 429 &amp; retry; literal &amp;amp; marker</summary>",
        "<error>429 &amp; retry; literal &amp;amp; marker</error>",
        "</task-notification>",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      toolUseId: "toolu_429",
      notification: {
        taskId: "agent_429",
        status: "failed",
        summary,
        error: providerMessage,
      },
    });
    expect(parsed?.notification.error).toBe(providerMessage);
  });
});
