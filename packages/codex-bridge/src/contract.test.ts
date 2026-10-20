import { describe, expect, it } from "vitest";
import {
  nativeBrowserCuaCapabilityExample,
  nativeDesktopContextExample,
  readCodexModels,
} from "./contract.example.js";
import type { CodexRpcPort } from "./contract.js";

describe("codex bridge contract", () => {
  it("example model read uses the native model/list RPC once", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const rpc: CodexRpcPort = {
      request: async <T = unknown>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return { models: [] } as T;
      },
      respond: async () => {},
      respondError: async () => {},
    };

    await expect(readCodexModels(rpc)).resolves.toEqual({ models: [] });
    expect(requests).toEqual([{ method: "model/list", params: { limit: 100 } }]);
  });

  it("examples keep capability fields scoped to the bridge contract", () => {
    expect(nativeBrowserCuaCapabilityExample.nativeBrowserCua).toEqual({
      browserAvailable: true,
      cuaAvailable: false,
    });
    expect(nativeDesktopContextExample).toEqual({ desktopContextPromptEnabled: true });
  });
});
