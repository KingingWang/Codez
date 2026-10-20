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

// ---------------------------------------------------------------------------
// mcp/projectConfigWrite（spec: specs/codex-desktop-mcp-settings.md）
// ---------------------------------------------------------------------------

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

interface WriteFixture {
  root: string;
  cwd: string;
  calls: { method: string; params: unknown }[];
  write: (params: Record<string, unknown>) => Promise<unknown>;
  readServers: () => Promise<Record<string, Record<string, unknown>>>;
}

async function writeFixture(options?: {
  dotCodexFolder?: string;
  existingToml?: string;
}): Promise<WriteFixture> {
  const root = await mkdtemp(join(tmpdir(), "codez-mcp-write-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const dotCodexFolder = options?.dotCodexFolder ?? null;
  if (dotCodexFolder) {
    await mkdir(dotCodexFolder, { recursive: true });
    if (options?.existingToml !== undefined)
      await writeFile(join(dotCodexFolder, "config.toml"), options.existingToml, "utf8");
  }
  const calls: { method: string; params: unknown }[] = [];
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "config/read")
        return {
          layers: dotCodexFolder
            ? [{ name: { type: "project", dotCodexFolder }, version: "v1", config: {} }]
            : [],
        } as T;
      if (method === "config/mcpServer/reload") return {} as T;
      throw new Error(`unexpected native call: ${method}`);
    },
    async respond() {},
    async respondError() {},
  };
  const context = { rpc, cwd };
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  return {
    root,
    cwd,
    calls,
    write: (params) =>
      handleControlRequest("mcp/projectConfigWrite", { workspace, ...params }, context),
    readServers: async () => {
      const file = join(dotCodexFolder ?? join(cwd, ".codex"), "config.toml");
      const table = parseToml(await readFile(file, "utf8")) as Record<string, unknown>;
      return (table["mcp_servers"] ?? {}) as Record<string, Record<string, unknown>>;
    },
  };
}

test("project upsert creates .codex/config.toml at cwd and reloads native runtime", async () => {
  const f = await writeFixture();
  await f.write({
    action: "upsert",
    name: "docs",
    config: { command: "npx", args: ["-y", "@example/docs"], env: { KEY: "v" } },
  });
  const servers = await f.readServers();
  assert.deepEqual(servers["docs"], {
    command: "npx",
    args: ["-y", "@example/docs"],
    env: { KEY: "v" },
  });
  assert.ok(f.calls.some((call) => call.method === "config/mcpServer/reload"));
});

test("project writes target the reported project layer and preserve unrelated config", async () => {
  const dot = join(await mkdtemp(join(tmpdir(), "codez-mcp-layer-")), "proj", ".codex");
  const f = await writeFixture({
    dotCodexFolder: dot,
    existingToml: '[features]\nfoo = true\n\n[mcp_servers.keep]\ncommand = "echo"\n',
  });
  await f.write({ action: "upsert", name: "web", config: { url: "https://example.com/mcp" } });
  const file = join(dot, "config.toml");
  const table = parseToml(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(table["features"], { foo: true });
  const servers = table["mcp_servers"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers["keep"], { command: "echo" });
  assert.deepEqual(servers["web"], { url: "https://example.com/mcp" });
});

test("project write rejects a dotCodexFolder Codex did not report", async () => {
  const f = await writeFixture();
  await assert.rejects(
    f.write({
      action: "upsert",
      name: "x",
      config: { command: "echo" },
      dotCodexFolder: "/etc/passwd-dir",
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: number }).code, -32602);
      return true;
    },
  );
});

test("project delete and set-enabled mutate only the target entry", async () => {
  const f = await writeFixture({
    dotCodexFolder: undefined,
    existingToml: undefined,
  });
  await f.write({ action: "upsert", name: "a", config: { command: "echo" } });
  await f.write({ action: "set-enabled", name: "a", enabled: false });
  let servers = await f.readServers();
  assert.equal(servers["a"]?.["enabled"], false);
  await f.write({ action: "set-enabled", name: "a", enabled: true });
  servers = await f.readServers();
  assert.ok(!("enabled" in (servers["a"] ?? {})));
  await f.write({ action: "delete", name: "a" });
  servers = await f.readServers();
  assert.equal(Object.keys(servers).length, 0);
});

test("project write rejects invalid names and missing configs", async () => {
  const f = await writeFixture();
  for (const name of ["has space", "has.dot", 'has"quote', ""]) {
    await assert.rejects(f.write({ action: "upsert", name, config: { command: "echo" } }), {
      code: -32602,
    });
  }
  await assert.rejects(f.write({ action: "upsert", name: "ok", config: {} }), { code: -32602 });
  await assert.rejects(f.write({ action: "set-enabled", name: "missing", enabled: false }), {
    code: -32602,
  });
});

test("project write rejects workspace mismatch like other control methods", async () => {
  const f = await writeFixture();
  const rpc: CodexRpcPort = {
    async request() {
      throw new Error("workspace mismatch must be rejected before any native call");
    },
    async respond() {},
    async respondError() {},
  };
  await assert.rejects(
    handleControlRequest(
      "mcp/projectConfigWrite",
      { workspace: { workspacePath: "/elsewhere" }, action: "delete", name: "a" },
      { rpc, cwd: f.cwd },
    ),
    { code: -32602 },
  );
});
