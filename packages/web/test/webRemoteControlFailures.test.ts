import { describe, expect, it } from "vitest";
import { createWebRemoteControlConnectionRecoveryTimeoutFailure } from "@codez/shared";

describe("web remote control failures", () => {
  it("maps mobile connection recovery timeout without marking desktop offline", () => {
    const failure = createWebRemoteControlConnectionRecoveryTimeoutFailure(
      "Mobile connection did not recover the RPC bridge in time.",
    );

    expect(failure).toEqual({
      reason: "connection-recovery-timeout",
      message: "Mobile connection did not recover the RPC bridge in time.",
    });
  });
});
