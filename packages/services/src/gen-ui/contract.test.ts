import { describe, expect, it } from "vitest";
import { exampleGenUiPrepare } from "./contract.example.js";
import { IGenUiService } from "./contract.js";
import { genUiServiceModule } from "./module.js";

describe("gen-ui service contract", () => {
  it("publishes the stable service channel and public entrypoints", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
    expect(genUiServiceModule.publicEntrypoints).toEqual(["index.ts", "contract.ts", "node.ts"]);
  });

  it("example prepare input carries the workspace-scoped document identity", () => {
    expect(exampleGenUiPrepare).toMatchObject({
      workspacePath: "/workspace",
      sessionId: "session",
      path: "/workspace/chart.html",
      ownerWebContentsId: 1,
      instanceKey: "message-1",
    });
    expect(exampleGenUiPrepare.html).toContain("chart");
  });
});
