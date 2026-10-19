import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import type { CodezProtocolMessage } from "@codez/shared";
import { V4_METHODS, type CommandEnvelope } from "@codez/shared/codez-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import type { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import type { ConversationShareArtifactSource } from "../src/conversation-share/conversationShareArtifactSource.js";
import type { ICodezAgentService } from "../src/codez-agent/codezAgent.js";
import {
  CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES,
  expandSharedContextContentCopy,
  type SharedContextContentCopyRecord,
} from "../src/conversation-share/codexSharedContextContentCopy.js";

const record = (contextId: string, content = '{"rows":[]}'): SharedContextContentCopyRecord => ({
  contextId,
  sessionId: "session",
  shareId: "share",
  title: "Shared title",
  shareUrl: "https://zcode.z.ai/cn/share/code",
  workspaceKey: "workspace",
  formatVersion: 1,
  formatterVersion: 1,
  content,
  capturedAt: 1_700_000_000_000,
});

test("shared context copy expands provenance and exact content", async () => {
  const expanded = await expandSharedContextContentCopy({
    text: "User prompt",
    refs: [{ kind: "shared_context_import", context_id: "context" }],
    workspacePath: "workspace",
    sessionId: "session",
    read: async () => record("context", '{"rows":[{"kind":"userInput","text":"hello"}]}'),
    now: () => 1_700_000_001_000,
  });
  assert.match(expanded, /User prompt/);
  assert.match(expanded, /Source: conversation-share-import/);
  assert.match(expanded, /Context ID: context/);
  assert.match(expanded, /Session ID: session/);
  assert.match(expanded, /Share ID: share/);
  assert.match(expanded, /Content SHA-256: [0-9a-f]{64}/);
  assert.match(
    expanded,
    /===== CONTENT BEGIN =====\n\{"rows":\[\{"kind":"userInput","text":"hello"\}\]\}\n===== CONTENT END =====/,
  );
  assert.doesNotMatch(expanded, /context_refs/);
});

test("multi-context expansion is all-or-nothing and rejects arbitrary ids without paths", async () => {
  let reads = 0;
  await assert.rejects(
    expandSharedContextContentCopy({
      text: "",
      refs: [
        { kind: "shared_context_import", context_id: "context-1" },
        { kind: "shared_context_import", context_id: "../../../etc/passwd" },
      ],
      workspacePath: "workspace",
      sessionId: "session",
      read: async (input) => {
        reads += 1;
        if (input.contextId === "context-1") return record("context-1");
        throw new Error("must not read arbitrary paths");
      },
    }),
    (error: unknown) => (error as { reasonCode?: string }).reasonCode === "invalid_context_id",
  );
  assert.equal(reads, 0);
});

test("empty, unknown formatter, and byte-limit failures are explicit", async () => {
  await assert.rejects(
    expandSharedContextContentCopy({
      text: "",
      refs: [{ kind: "shared_context_import", context_id: "empty" }],
      workspacePath: "workspace",
      sessionId: "session",
      read: async () => ({ ...record("empty"), content: "" }),
    }),
    (error: unknown) => (error as { reasonCode?: string }).reasonCode === "empty_content",
  );
  await assert.rejects(
    expandSharedContextContentCopy({
      text: "",
      refs: [{ kind: "shared_context_import", context_id: "future" }],
      workspacePath: "workspace",
      sessionId: "session",
      read: async () => ({ ...record("future"), formatVersion: 2 }),
    }),
    (error: unknown) => (error as { reasonCode?: string }).reasonCode === "unknown_formatter",
  );
  await assert.rejects(
    expandSharedContextContentCopy({
      text: "",
      refs: [{ kind: "shared_context_import", context_id: "large" }],
      workspacePath: "workspace",
      sessionId: "session",
      read: async () => record("large", "x".repeat(CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES)),
    }),
    (error: unknown) => {
      const typed = error as { reasonCode?: string; limit?: number; observedBytes?: number };
      return (
        typed.reasonCode === "byte_limit_exceeded" &&
        typed.limit === CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES &&
        typed.observedBytes !== undefined
      );
    },
  );
});

test("persisted shared context reader authorizes workspace and session", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-shared-copy-"));
  const shareRoot = join(root, ".codez-share", "share");
  await mkdir(shareRoot, { recursive: true });
  const persisted = {
    formatVersion: 1,
    shareId: "share",
    contextId: "context",
    title: "Shared title",
    sessionId: "session",
    shareUrl: "https://zcode.z.ai/cn/share/code",
    workspaceKey: "workspace",
    formatterVersion: 1,
    createdAt: 1_700_000_000_000,
    rows: [],
    artifacts: [],
  };
  await writeFile(join(shareRoot, "shared-conversation.json"), JSON.stringify(persisted), "utf8");
  const artifactSource = {
    async read() {
      throw new Error("not used");
    },
  } as unknown as ConversationShareArtifactSource;
  const service = new ConversationShareService({
    codezAgentService: {} as ICodezAgentService,
    client: {} as ConversationShareHttpClient,
    artifactSource,
    conversationWorkspaceRoot: root,
  });
  try {
    const content = await service.readSharedContextContentCopy({
      workspacePath: "workspace",
      sessionId: "session",
      contextId: "context",
    });
    assert.equal(content.content, JSON.stringify(persisted));
    assert.equal(content.capturedAt, persisted.createdAt);
    await assert.rejects(
      service.readSharedContextContentCopy({
        workspacePath: "workspace",
        sessionId: "other-session",
        contextId: "context",
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authorization_failed",
    );
    await assert.rejects(
      service.readSharedContextContentCopy({
        workspacePath: "other-workspace",
        sessionId: "session",
        contextId: "context",
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authorization_failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createMemoryClient(options?: { failCommand?: boolean }) {
  const sent: CodezProtocolMessage[] = [];
  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      sent.push(message);
      if (!("id" in message && "method" in message)) return;
      if (options?.failCommand && message.method === V4_METHODS.command)
        throw new Error("disconnected");
      messages.fire({
        id: message.id,
        result: {
          commandId: (message.params as CommandEnvelope).commandId,
          status: "accepted",
          revisionAtDecision: 1,
        },
      });
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  return { client, sent };
}

function sendEnvelope(): CommandEnvelope {
  return {
    commandId: "shared-context-command",
    clientId: "ui",
    sessionId: "session",
    issuedAt: 1,
    type: "sendText",
    payload: {
      text: "Continue this conversation",
      context_refs: [{ kind: "shared_context_import", context_id: "context" }],
    },
  };
}

test("Codex V4 send path expands refs and strips context_refs before dispatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-shared-"));
  setDataBaseDir(dir);
  const { client, sent } = createMemoryClient();
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => client);
  const service = createCodezAgentService({
    presentationSurface: "desktop",
    readSharedContextContentCopy: async () => record("context", '{"rows":[]}'),
  });
  try {
    const ack = await service.sendConversationCommandV4({
      workspacePath: "workspace",
      workspaceIdentity: "workspace",
      envelope: sendEnvelope(),
    });
    assert.equal(ack.status, "accepted");
    const command = sent.at(-1);
    assert.ok(command && "params" in command);
    const params = command.params as CommandEnvelope;
    const payload = params.payload as { text: string; context_refs?: unknown };
    assert.equal(payload.context_refs, undefined);
    assert.match(payload.text, /Continue this conversation/);
    assert.match(payload.text, /CODEZ SHARED CONTEXT COPY BEGIN/);
    assert.equal(sent.length, 1);
  } finally {
    await service.disposeAllAndWait();
    client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing capability or read failure sends no bridge command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-shared-"));
  setDataBaseDir(dir);
  const missing = createMemoryClient();
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => missing.client);
  const missingService = createCodezAgentService({ presentationSurface: "desktop" });
  const failure = createMemoryClient();
  const failureService = createCodezAgentService({
    presentationSurface: "desktop",
    readSharedContextContentCopy: async () => {
      throw new Error("read failed");
    },
  });
  try {
    await assert.rejects(
      missingService.sendConversationCommandV4({
        workspacePath: "workspace",
        envelope: sendEnvelope(),
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "capability_missing",
    );
    await assert.rejects(
      failureService.sendConversationCommandV4({
        workspacePath: "workspace",
        envelope: sendEnvelope(),
      }),
      /read failed/,
    );
    assert.equal(missing.sent.length, 0);
    assert.equal(failure.sent.length, 0);
  } finally {
    await missingService.disposeAllAndWait();
    await failureService.disposeAllAndWait();
    missing.client.dispose();
    failure.client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("transport disconnect does not automatically resend the shared-context command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-shared-"));
  setDataBaseDir(dir);
  const disconnected = createMemoryClient({ failCommand: true });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => disconnected.client);
  const service = createCodezAgentService({
    presentationSurface: "desktop",
    readSharedContextContentCopy: async () => record("context", '{"rows":[]}'),
  });
  try {
    await assert.rejects(
      service.sendConversationCommandV4({
        workspacePath: "workspace",
        envelope: sendEnvelope(),
      }),
      /disconnected/,
    );
    assert.equal(disconnected.sent.length, 1);
  } finally {
    await service.disposeAllAndWait();
    disconnected.client.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
