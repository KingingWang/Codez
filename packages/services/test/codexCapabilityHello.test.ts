import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import { codezProtocolMethods, type CodezProtocolMessage } from "@codez/shared";
import { V4_METHODS, type CommandEnvelope } from "@codez/shared/codez-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { createCodezAgentConnectionScope } from "../src/codez-agent/codezAgentConnectionScope.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

const nativeCodexCapabilities = {
  auxiliaryTextGeneration: "supported",
  observedSessionUsage: "supported",
  observedAppUsage: "unsupported",
  sharedContextContentCopy: "unsupported",
  scheduledPromptAutomations: "supported",
  nativeBrowserCuaMcp: "unsupported",
  readOnlyWorkflowHistory: "supported",
  safeDesktopFileRewind: "supported",
  legacyWorkflowRuns: "unsupported",
} as const;

function createCapabilityClient(options: { result: "full" | "old" | "failure" }): {
  client: CodezProtocolClient;
  requests: string[];
} {
  const requests: string[] = [];
  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if (!("id" in message && "method" in message)) return;
      requests.push(message.method);
      if (message.method !== codezProtocolMethods.runtimeCapabilities) return;
      if (options.result === "failure") throw new Error("bridge unavailable");
      messages.fire({
        id: message.id,
        result:
          options.result === "full"
            ? { independentPlanState: true, codex: nativeCodexCapabilities }
            : { independentPlanState: true },
      });
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  return { client, requests };
}

test("missing shared-context resolver stays unsupported", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-capability-hello-"));
  setDataBaseDir(dir);
  const { client } = createCapabilityClient({ result: "full" });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);
  const service = createCodezAgentService({ presentationSurface: "desktop" });
  try {
    const hello = await service.helloConversationV4();
    assert.equal(hello.capabilities.codex?.sharedContextContentCopy, "unsupported");
  } finally {
    await service.disposeAllAndWait();
    client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolver wrapper that always rejects does not create shared-context capability", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-capability-hello-"));
  setDataBaseDir(dir);
  const { client, requests } = createCapabilityClient({ result: "full" });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);
  const service = createCodezAgentService({
    presentationSurface: "desktop",
    readSharedContextContentCopy: async () => {
      throw new Error("feature_disabled");
    },
  });
  try {
    const hello = await service.helloConversationV4();
    assert.equal(hello.capabilities.codex?.sharedContextContentCopy, "unsupported");
    await assert.rejects(
      service.sendConversationCommandV4({
        workspacePath: dir,
        workspaceIdentity: "remote-identity",
        envelope: {
          commandId: "remote-shared-context",
          clientId: "ui",
          sessionId: "session",
          issuedAt: 1,
          type: "sendText",
          payload: {
            text: "Continue",
            context_refs: [{ kind: "shared_context_import", context_id: "context" }],
          },
        } satisfies CommandEnvelope,
      }),
      /feature_disabled/,
    );
    assert.deepEqual(requests, [codezProtocolMethods.runtimeCapabilities]);
  } finally {
    await service.disposeAllAndWait();
    client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex hello distinguishes bridge failure, old peer, and connection scope", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-capability-hello-"));
  setDataBaseDir(dir);
  const full = createCapabilityClient({ result: "full" });
  const old = createCapabilityClient({ result: "old" });
  const failure = createCapabilityClient({ result: "failure" });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => full.client);
  const fullService = createCodezAgentService({
    presentationSurface: "desktop",
    readSharedContextContentCopy: Object.assign(
      async () => {
        throw new Error("resolver must not be called by hello");
      },
      { supportsSharedContextContentCopy: true as const },
    ),
  });
  const fullScope = createCodezAgentConnectionScope(fullService, {
    connectionId: "full-connection",
    clientMode: "desktop-continuous",
  });
  let oldService: ReturnType<typeof createCodezAgentService> | undefined;
  let failureService: ReturnType<typeof createCodezAgentService> | undefined;
  let oldScope: ReturnType<typeof createCodezAgentConnectionScope> | undefined;
  let failureScope: ReturnType<typeof createCodezAgentConnectionScope> | undefined;
  try {
    const scoped = await fullScope.service.helloConversationV4();
    assert.equal(scoped.connectionId, "full-connection");
    assert.deepEqual(scoped.capabilities.codex, {
      ...nativeCodexCapabilities,
      observedAppUsage: "supported",
      sharedContextContentCopy: "degraded",
      safeDesktopFileRewind: "unsupported",
    });
    assert.equal(scoped.capabilities.codexUnavailable, undefined);

    t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => old.client);
    oldService = createCodezAgentService({ presentationSurface: "desktop" });
    const oldHello = await oldService.helloConversationV4();
    assert.equal(oldHello.capabilities.codex, undefined);
    assert.equal(oldHello.capabilities.codexUnavailable, undefined);
    assert.deepEqual(old.requests, [codezProtocolMethods.runtimeCapabilities]);

    t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => failure.client);
    failureService = createCodezAgentService({ presentationSurface: "desktop" });
    const failureHello = await failureService.helloConversationV4();
    assert.equal(failureHello.capabilities.codex, undefined);
    assert.deepEqual(failureHello.capabilities.codexUnavailable, {
      reason: "bridge-unavailable",
    });
    assert.deepEqual(failure.requests, [codezProtocolMethods.runtimeCapabilities]);

    const oldScopeService = oldService;
    const failureScopeService = failureService;
    if (!oldScopeService || !failureScopeService) throw new Error("scope services missing");
    oldScope = createCodezAgentConnectionScope(oldScopeService, {
      connectionId: "old-connection",
      clientMode: "desktop-continuous",
    });
    const scopedOld = await oldScope.service.helloConversationV4();
    assert.equal(scopedOld.connectionId, "old-connection");
    assert.equal(scopedOld.capabilities.codex, undefined);
    assert.equal(scopedOld.capabilities.codexUnavailable, undefined);

    failureScope = createCodezAgentConnectionScope(failureScopeService, {
      connectionId: "failure-connection",
      clientMode: "desktop-continuous",
    });
    const scopedFailure = await failureScope.service.helloConversationV4();
    assert.equal(scopedFailure.connectionId, "failure-connection");
    assert.equal(scopedFailure.capabilities.codex, undefined);
    assert.deepEqual(scopedFailure.capabilities.codexUnavailable, {
      reason: "bridge-unavailable",
    });
  } finally {
    await fullScope.dispose();
    await oldScope?.dispose();
    await failureScope?.dispose();
    await oldService?.disposeAllAndWait();
    await failureService?.disposeAllAndWait();
    full.client.dispose();
    old.client.dispose();
    failure.client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("connection scope forwards Codex history runs without synthesizing workflow state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-history-scope-"));
  setDataBaseDir(dir);
  const sent: CodezProtocolMessage[] = [];
  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const result = {
    runs: [],
    atSeq: 7,
    atRevision: 3,
    atLogEpoch: "epoch-1",
    source: "native-thread",
  } as const;
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if (!("id" in message && "method" in message)) return;
      sent.push(message);
      if (message.method === codezProtocolMethods.runtimeCapabilities) {
        messages.fire({ id: message.id, result: { independentPlanState: true } });
        return;
      }
      if (message.method === V4_METHODS.codexConversationHistoryRuns) {
        messages.fire({ id: message.id, result });
      }
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);
  const service = createCodezAgentService({ presentationSurface: "desktop" });
  const scope = createCodezAgentConnectionScope(service, {
    connectionId: "history-connection",
    clientMode: "desktop-continuous",
  });
  try {
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: (await scope.service.helloConversationV4()).protocolVersion,
      clientId: "history-client",
      appVersion: "test",
    });
    const history = await scope.service.codexHistoryRunsV4({
      workspacePath: dir,
      workspaceIdentity: "history-workspace",
      sessionId: "thread-1",
      limit: 2,
      status: "completed",
    });
    assert.deepEqual(history, result);
    const request = sent.at(-1);
    assert.equal(request?.method, V4_METHODS.codexConversationHistoryRuns);
    assert.deepEqual("params" in request ? request.params : undefined, {
      sessionId: "thread-1",
      limit: 2,
      status: "completed",
    });
  } finally {
    await scope.dispose();
    await service.disposeAllAndWait();
    client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
