import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import { resolveWorkspaceKey, type CodexRequest, type CodezProtocolMessage } from "@codez/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

test("native requests validate before startup, preserve identity, and bypass only legacy readiness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-service-"));
  setDataBaseDir(dir);
  const previousCommand = process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  const clients = new Map<string, CodezProtocolClient>();
  const starts: string[] = [];
  const sent: Array<{ key: string; message: CodezProtocolMessage }> = [];
  let providerReads = 0;
  let readinessReads = 0;
  let notifyAccount: ((reason: string) => void) | undefined;
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async (workspace) => {
    const key = resolveWorkspaceKey(workspace);
    starts.push(key);
    let client = clients.get(key);
    if (!client) {
      const messages = new Emitter<CodezProtocolMessage>();
      const closes = new Emitter<{ reason?: string }>();
      client = new CodezProtocolClient({
        kind: "memory",
        onMessage: messages.event,
        onClose: closes.event,
        async send(message) {
          sent.push({ key, message });
          if ("id" in message && "method" in message) {
            if (
              message.method === "codex/request" &&
              (message.params as CodexRequest).method === "account/logout"
            ) {
              messages.fire({ id: message.id, error: { code: -32000, message: "native refused" } });
            } else {
              messages.fire({ id: message.id, result: { native: true } });
            }
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
  const options: Parameters<typeof createCodezAgentService>[0] = {
    presentationSurface: "desktop",
    modelSelectionReadinessSource: {
      async getView() {
        readinessReads += 1;
        throw new Error("legacy provider unavailable");
      },
    },
    accountProviderConfigSource: {
      async read() {
        providerReads += 1;
        throw new Error("legacy account unavailable");
      },
      onDidChange(listener) {
        notifyAccount = listener;
        return () => {};
      },
    },
  };
  const service = createCodezAgentService(options);
  const workspace = { workspacePath: dir, workspaceIdentity: "remote-a" };
  try {
    for (const request of [
      { method: "thread/start" },
      { method: "account/read", unexpected: true },
      { method: 12 },
    ]) {
      await assert.rejects(
        service.codexRequest({ ...workspace, request: request as CodexRequest }),
      );
    }
    assert.equal(starts.length, 0, "invalid requests cannot start a process");
    for (const request of [
      { method: "account/read" },
      { method: "config/value/write", params: { keyPath: "model", value: "example" } },
    ] satisfies CodexRequest[]) {
      assert.deepEqual(await service.codexRequest({ ...workspace, request }), { native: true });
      assert.deepEqual(sent.at(-1)?.message, {
        id: sent.length,
        method: "codex/request",
        params: request,
      });
    }
    await service.codexRequest({
      ...workspace,
      workspaceIdentity: "remote-b",
      request: { method: "model/list" },
    });
    assert.deepEqual(starts, ["remote-a", "remote-b"]);
    assert.deepEqual([...clients.keys()], ["remote-a", "remote-b"]);
    assert.equal((await service.initialize(workspace)).available, true);
    assert.equal(readinessReads, 0);

    // Schema failure is intentional: the fake native response is not a workspace projection.
    // The request must still reach native without reading or synchronizing legacy credentials.
    await assert.rejects(service.readWorkspacePresentation(workspace));
    notifyAccount?.("test-change");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(providerReads, 0);
    assert.equal(
      sent.some(
        ({ message }) => "method" in message && message.method === "provider/updateAccountConfig",
      ),
      false,
    );

    const beforeFailure = sent.length;
    await assert.rejects(
      service.codexRequest({ ...workspace, request: { method: "account/logout" } }),
      /native refused/,
    );
    assert.equal(sent.length, beforeFailure + 1, "native mutations are never retried");

    const legacyService = createCodezAgentService({ ...options, commandResolver: () => null });
    try {
      assert.equal((await legacyService.initialize(workspace)).available, false);
      assert.equal(readinessReads, 1, "custom runtimes retain their readiness gate");
      assert.deepEqual(
        await legacyService.codexRequest({ ...workspace, request: { method: "account/read" } }),
        { native: true },
      );
      assert.equal(
        readinessReads,
        1,
        "settings use read-only startup even for an explicit bridge override",
      );
    } finally {
      await legacyService.disposeAllAndWait();
    }
  } finally {
    await service.disposeAllAndWait();
    for (const client of clients.values()) client.dispose();
    setDataBaseDir(null);
    if (previousCommand === undefined) delete process.env.CODEZ_AGENT_SERVER_COMMAND;
    else process.env.CODEZ_AGENT_SERVER_COMMAND = previousCommand;
    await rm(dir, { recursive: true, force: true });
  }
});
