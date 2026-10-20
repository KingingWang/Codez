import { describe, expect, it } from "vitest";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";

describe("V4 prompt scroll focus policy", () => {
  it("focuses only draft sends and preserves subsequent start-now reading position", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: true,
        inputRoutingMode: null,
      }),
    ).toBe(true);
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "startNow",
      }),
    ).toBe(false);
  });

  it("preserves the reading position when the new prompt only enqueues", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "enqueue",
      }),
    ).toBe(false);
  });

  it("preserves reading position after either held-queue choice", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "choice",
        heldQueueDisposition: "clearQueueAndSend",
      }),
    ).toBe(false);
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "choice",
        heldQueueDisposition: "keepQueueAndSend",
      }),
    ).toBe(false);
  });
});
