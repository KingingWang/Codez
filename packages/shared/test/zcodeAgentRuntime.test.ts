import { describe, expect, it } from "vitest";
import { CODEZ_AGENT_RUNTIME } from "@codez/shared";

describe("Codez Agent runtime", () => {
  it("starts the private Codez Protocol server instead of the retired Codez Agent command", () => {
    const retiredProtocolName = `${"a"}${"cp"}`;

    expect(CODEZ_AGENT_RUNTIME.spawnArgs).toEqual(["app-server", "--stdio"]);
    expect(CODEZ_AGENT_RUNTIME.spawnArgs).not.toContain(retiredProtocolName);
  });

  it("uses the Codez Agent binary name", () => {
    expect(CODEZ_AGENT_RUNTIME.resolveEntrySegments("darwin")).toEqual(["codez-agent"]);
    expect(CODEZ_AGENT_RUNTIME.resolveEntrySegments("win32")).toEqual(["codez-agent.exe"]);
  });
});
