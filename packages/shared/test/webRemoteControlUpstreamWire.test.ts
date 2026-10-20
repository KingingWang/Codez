import { describe, expect, it } from "vitest";
import { ServiceChannels, UpstreamServiceChannelAliases } from "../src/channels.js";
import { parseWebRemoteControlAppPayload } from "../src/validation.js";
import { encodeWebRemoteControlRpcTransportMessage } from "../src/web-remote-control-rpc-transport.js";

describe("upstream mobile remote wire compatibility", () => {
  it("accepts upstream bootstrap and view-state payloads without renaming internal routing", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "bootstrap-request",
        requestId: "bootstrap-upstream",
      }),
    ).toEqual({ codez_type: "bootstrap-request", requestId: "bootstrap-upstream" });
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-view-state-update",
        viewState: { activeWorkspaceKey: "/workspace", updatedAt: 1 },
      }),
    ).toEqual({
      codez_type: "mobile-view-state-update",
      viewState: { activeWorkspaceKey: "/workspace", updatedAt: 1 },
    });
  });

  it("accepts upstream strict raw frames and ACKs with the same identity and checksum", () => {
    const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-upstream",
      bridgeGeneration: 2,
      recoveryId: "recovery-upstream",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    const { codez_type, ...fields } = frame;
    expect(parseWebRemoteControlAppPayload({ zcode_type: codez_type, ...fields })).toEqual(frame);
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "rpc-frame-ack",
        bridgeSessionId: frame.bridgeSessionId,
        bridgeGeneration: 2,
        recoveryId: "recovery-upstream",
        ackMessageSeq: 1,
      }),
    ).toEqual({
      codez_type: "rpc-frame-ack",
      bridgeSessionId: frame.bridgeSessionId,
      bridgeGeneration: 2,
      recoveryId: "recovery-upstream",
      ackMessageSeq: 1,
    });
    expect(
      parseWebRemoteControlAppPayload({ zcode_type: codez_type, ...fields, extra: true }),
    ).toBeNull();
  });

  it("does not weaken validation or allow ambiguous discriminators", () => {
    for (const payload of [
      { zcode_type: "bootstrap-request" },
      { zcode_type: "bootstrap-request", requestId: 1 },
      { zcode_type: "unknown", requestId: "bootstrap-upstream" },
      {
        zcode_type: "bootstrap-request",
        codez_type: "bootstrap-request",
        requestId: "bootstrap-upstream",
      },
      {
        zcode_type: "bootstrap-request",
        codez_type: "workspace-list-request",
        requestId: "bootstrap-upstream",
      },
    ]) {
      expect(parseWebRemoteControlAppPayload(payload)).toBeNull();
    }
    expect(
      parseWebRemoteControlAppPayload({
        codez_type: "bootstrap-request",
        requestId: "bootstrap-fork",
      }),
    ).toEqual({ codez_type: "bootstrap-request", requestId: "bootstrap-fork" });
  });

  it("keeps public RPC service channels compatible with the hosted upstream page", () => {
    expect(ServiceChannels.CodezTask).toBe("codez-task");
    expect(ServiceChannels.CodezAgent).toBe("codez-agent");
    expect(ServiceChannels.CodezSession).toBe("codez-session");
    expect(UpstreamServiceChannelAliases).toEqual({
      "codez-task": "zcode-task",
      "codez-agent": "zcode-agent",
      "codez-session": "zcode-session",
    });
  });
});
