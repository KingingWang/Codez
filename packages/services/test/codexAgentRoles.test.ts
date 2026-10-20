import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import { resolveWorkspaceKey, type CodezProtocolMessage } from "@codez/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

const ROLE_SUMMARY = {
  scope: "project",
  name: "reviewer",
  description: "Reviews code",
  developerInstructions: "You review.",
  fileName: "reviewer.toml",
} as const;

// agents/* 载体铁律的回归测试：方法必须打到真实 workspace client（按 workspaceKey 区分），
// 且请求里的 workspace.workspacePath 就是真实 cwd——project scope 在 bridge 侧解析
// <attachment cwd>/.codex/agents，合成 plugin management 路径会被 bridge 拒绝。
async function carrierFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "codez-agents-service-"));
  setDataBaseDir(dir);
  const starts: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  const sent: Array<{ key: string; method: string; params: Record<string, unknown> }> = [];
  const clients = new Map<string, CodezProtocolClient>();
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async (workspace) => {
    const key = resolveWorkspaceKey(workspace);
    starts.push({
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    });
    let client = clients.get(key);
    if (!client) {
      const messages = new Emitter<CodezProtocolMessage>();
      const closes = new Emitter<{ reason?: string }>();
      client = new CodezProtocolClient({
        kind: "memory",
        onMessage: messages.event,
        onClose: closes.event,
        async send(message) {
          if (!("id" in message && "method" in message)) return;
          const params = (message.params ?? {}) as Record<string, unknown>;
          sent.push({ key, method: message.method, params });
          if (message.method === "agents/list") {
            messages.fire({
              id: message.id,
              result: { roles: [ROLE_SUMMARY], diagnostics: [] },
            });
          } else if (message.method === "agents/write") {
            messages.fire({ id: message.id, result: { role: ROLE_SUMMARY } });
          } else if (message.method === "agents/delete") {
            messages.fire({ id: message.id, result: {} });
          } else {
            // 客户端就绪期的策略同步等其它请求按旧 CLI 语义回 method-not-found。
            messages.fire({
              id: message.id,
              error: { code: -32601, message: "method not found" },
            });
          }
        },
        dispose() {
          messages.dispose();
          closes.dispose();
        },
      });
      clients.set(key, client);
    }
    return client;
  });
  const service = createCodezAgentService({ presentationSurface: "desktop" });
  return { dir, service, starts, sent };
}

test("local workspace carrier: agents/* resolve to the actual cwd, never the synthetic management path", async (t) => {
  const { dir, service, starts, sent } = await carrierFixture(t);
  const workspace = { workspacePath: dir };
  const list = await service.listAgentRoles(workspace);
  assert.equal(list.roles[0]?.name, "reviewer");
  assert.deepEqual(starts, [{ workspacePath: dir }]);
  const listRequest = sent.find((entry) => entry.method === "agents/list");
  assert.ok(listRequest);
  assert.equal(listRequest.key, dir);
  assert.deepEqual(listRequest.params.workspace, {
    workspacePath: dir,
    workspaceIdentity: undefined,
    remoteSessionId: undefined,
    workspaceKey: dir,
  });

  await service.writeAgentRole({
    ...workspace,
    scope: "project",
    role: { name: "reviewer", developerInstructions: "You review." },
  });
  const writeRequest = sent.find((entry) => entry.method === "agents/write");
  assert.ok(writeRequest);
  assert.equal(writeRequest.key, dir);
  assert.equal((writeRequest.params.workspace as { workspacePath: string }).workspacePath, dir);
  assert.equal("originalName" in writeRequest.params, false);
  assert.deepEqual(writeRequest.params.role, {
    name: "reviewer",
    developerInstructions: "You review.",
  });

  await service.deleteAgentRole({ ...workspace, scope: "user", name: "reviewer" });
  const deleteRequest = sent.find((entry) => entry.method === "agents/delete");
  assert.ok(deleteRequest);
  assert.equal(deleteRequest.key, dir);

  // 全过程只为真实 workspace 拉起 client；合成 plugin management 路径绝不能出现。
  assert.equal(starts.length, 1);
  assert.equal(
    starts.some((entry) => entry.workspacePath.includes("plugin-workspace")),
    false,
  );
  service.disposeAll();
});

test("remote (SSH identity) workspace carrier: agents/* route by identity with the remote cwd", async (t) => {
  const { service, starts, sent } = await carrierFixture(t);
  const remote = { workspacePath: "/home/remote/project", workspaceIdentity: "ssh:dev@box" };
  await service.listAgentRoles(remote);
  assert.deepEqual(starts, [
    { workspacePath: "/home/remote/project", workspaceIdentity: "ssh:dev@box" },
  ]);
  const listRequest = sent.find((entry) => entry.method === "agents/list");
  assert.ok(listRequest);
  assert.equal(listRequest.key, "ssh:dev@box");
  // 远程 project scope 的 cwd 原样下推；bridge 在远端按它解析 <cwd>/.codex/agents。
  assert.deepEqual(listRequest.params.workspace, {
    workspacePath: "/home/remote/project",
    workspaceIdentity: "ssh:dev@box",
    remoteSessionId: undefined,
    workspaceKey: "ssh:dev@box",
  });

  await service.writeAgentRole({
    ...remote,
    scope: "user",
    originalName: "reviewer",
    role: { name: "reviewer", developerInstructions: "You review harder." },
  });
  const writeRequest = sent.find((entry) => entry.method === "agents/write");
  assert.ok(writeRequest);
  assert.equal(writeRequest.key, "ssh:dev@box");
  assert.equal(writeRequest.params.originalName, "reviewer");
  service.disposeAll();
});
