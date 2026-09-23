import assert from "node:assert/strict";
import test from "node:test";
import { codezMcpListResultSchema } from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import { handleControlRequest } from "../src/control-plane.js";

const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };
function fixture(status: string | null = "connected", configured = true) {
  const calls: { method: string; params: unknown }[] = [];
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "config/read")
        return {
          config: { mcp_servers: configured ? { fixture: { command: "fixture" } } : {} },
        } as T;
      assert.equal(method, "mcpServerStatus/list");
      return {
        data: [
          {
            name: "fixture",
            runtimeStatus: status,
            tools: { tool: {} },
            toolsError: null,
            authStatus: "notLoggedIn",
          },
        ],
        nextCursor: null,
      } as T;
    },
    async respond() {},
    async respondError() {},
  };
  return { context: { rpc, cwd: "/workspace" }, calls };
}

test("MCP list maps actual runtime state and transport rather than inferring from tools/auth", async () => {
  for (const [native, expected] of [
    ["connected", "connected"],
    ["starting", "connecting"],
    ["authenticationRequired", "failed"],
    ["notStarted", "disconnected"],
    ["cancelled", "disconnected"],
    [null, "disconnected"],
    ["disabled", "disabled"],
  ]) {
    const { context } = fixture(native);
    const result = codezMcpListResultSchema.parse(
      await handleControlRequest("mcp/list", { workspace, mode: "status" }, context),
    );
    assert.equal(result.statuses.fixture?.status, expected);
    assert.equal(result.statuses.fixture?.transport, "stdio");
    assert.equal(result.statuses.fixture?.toolCount, 1);
  }
});

test("unknown MCP transport is not fabricated", async () => {
  const { context } = fixture("connected", false);
  await assert.rejects(handleControlRequest("mcp/list", { workspace }, context), { code: -32601 });
});

test("MCP pagination repeats fail closed, not truncated success", async () => {
  const { context } = fixture();
  const original = context.rpc.request.bind(context.rpc);
  context.rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "config/read") return original<T>(method, params);
    return { data: [], nextCursor: "repeated" } as T;
  };
  await assert.rejects(handleControlRequest("mcp/list", { workspace }, context), { code: -32000 });
});
