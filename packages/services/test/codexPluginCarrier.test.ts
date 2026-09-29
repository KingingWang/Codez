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

test("Codex plugin inventory and install use the real workspace carrier, including remote identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-plugin-carrier-"));
  setDataBaseDir(dir);
  const started: Array<{ key: string; cwd: string }> = [];
  const calls: Array<{ key: string; method: string; workspace: unknown }> = [];
  const clients = new Map<string, CodezProtocolClient>();
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async (target) => {
    const key = resolveWorkspaceKey(target);
    started.push({ key, cwd: target.workspacePath });
    let client = clients.get(key);
    if (client) return client;
    const messages = new Emitter<CodezProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    client = new CodezProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      async send(message) {
        if (!("id" in message && "method" in message)) return;
        const params = (message.params ?? {}) as { workspace?: unknown };
        calls.push({ key, method: message.method, workspace: params.workspace });
        const result =
          message.method === "plugins/overview"
            ? {
                marketplaces: [],
                availablePlugins: [],
                installedPlugins: [],
                restorableBuiltins: [],
                diagnostics: [],
                capability: { supported: true },
              }
            : message.method === "plugins/install"
              ? { installedPlugins: [], dependencyClosure: [], diagnostics: [] }
              : null;
        if (result) messages.fire({ id: message.id, result });
        else
          messages.fire({ id: message.id, error: { code: -32601, message: "method not found" } });
      },
      dispose() {
        messages.dispose();
        closes.dispose();
      },
    });
    clients.set(key, client);
    return client;
  });
  const service = createCodezAgentService({ presentationSurface: "desktop" });
  const workspace = {
    workspacePath: "/remote/project",
    workspaceIdentity: "ssh:dev@remote",
  };
  try {
    const overview = await service.getPluginsOverview(workspace);
    assert.equal(overview.capability.supported, true);
    await service.installPlugin({
      ...workspace,
      pluginName: "github",
      marketplace: "codez-plugins-official",
      scope: "user",
    });
    assert.deepEqual(started, [{ key: workspace.workspaceIdentity, cwd: workspace.workspacePath }]);
    assert.deepEqual(
      calls.filter((call) => call.method.startsWith("plugins/")),
      ["plugins/overview", "plugins/install"].map((method) => ({
        key: workspace.workspaceIdentity,
        method,
        workspace: {
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          remoteSessionId: undefined,
          workspaceKey: workspace.workspaceIdentity,
        },
      })),
    );
    assert.equal(
      started.some((item) => item.cwd.includes("plugin-workspace")),
      false,
    );
  } finally {
    service.disposeAll();
  }
});
