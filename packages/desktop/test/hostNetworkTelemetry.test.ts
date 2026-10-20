import { describe, expect, it, vi, afterEach } from "vitest";
import { HostResponseTypes } from "@codez/shared";
import { emitNetworkTelemetryObservation } from "@codez/rpc";
import {
  registerHostNetworkTelemetry,
  stopHostNetworkTelemetry,
} from "../src/host/hostNetworkTelemetry.js";

class FakeParentPort {
  readonly postedMessages: unknown[] = [];

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }
}

describe("hostNetworkTelemetry", () => {
  afterEach(() => {
    stopHostNetworkTelemetry();
    vi.useRealTimers();
  });

  it("flushes network observations through the injected Electron parentPort", () => {
    vi.useFakeTimers();
    const parentPort = new FakeParentPort();
    registerHostNetworkTelemetry(parentPort);

    emitNetworkTelemetryObservation({
      transport: "http",
      interface: "codez_agent.model.openai-compatible.sse.api.example.com/v1",
      durationMs: 456,
      ok: true,
      attempt: 2,
    });

    stopHostNetworkTelemetry();

    expect(parentPort.postedMessages).toEqual([
      {
        type: HostResponseTypes.NetworkTelemetryBatch,
        observations: [
          {
            transport: "http",
            interface: "codez_agent.model.openai-compatible.sse.api.example.com/v1",
            durationMs: 456,
            ok: true,
            attempt: 2,
          },
        ],
      },
    ]);
  });
});
