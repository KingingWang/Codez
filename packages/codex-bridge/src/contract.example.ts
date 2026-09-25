import type { CodexRpcPort } from "./contract.js";

export async function readCodexModels(rpc: CodexRpcPort): Promise<unknown> {
  return rpc.request("model/list", { limit: 100 });
}

export const nativeBrowserCuaCapabilityExample = {
  nativeBrowserCua: {
    browserAvailable: true,
    cuaAvailable: false,
  },
} as const;
