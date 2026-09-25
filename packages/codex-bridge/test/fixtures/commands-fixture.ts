import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandAckSchema,
  parseCommandEnvelope,
  type CommandEnvelope,
  type CommandType,
} from "@codez/shared/codez-protocol-v4";
import { CommandRouter, type CommandContext } from "../../src/commands.js";
import { CommandLedger } from "../../src/command-ledger.js";
import { ThreadStateStore } from "../../src/thread-state.js";
import { InteractionBroker } from "../../src/interactions.js";
import type { CodexRpcPort } from "../../src/contract.js";
import type { CodexTurn } from "../../src/codex-types.js";
import { RewindNoticeStore } from "../../src/rewind-notice.js";
import { threadFixture } from "../projection-fixtures.test.js";

export const cwd = "/workspace";
export const workspaceId = "remote-workspace-identity";
export const sessionId = "thread-1";
export const selection = {
  providerId: "openai",
  modelId: "native-model",
  options: { reasoningLevel: "high" },
};
export const attachment = {
  ref: "fixture-image",
  fileName: "image.png",
  mime: "image/png",
  bytes: 5,
};
export const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];
export const queued = (id: string) => ({
  id,
  clientUserMessageId: `external-${id}`,
  input: textInput(id),
});
export const turn = (id = "live-turn"): CodexTurn => ({
  id,
  status: "inProgress",
  itemsView: "full",
  items: [],
  startedAt: 121,
  completedAt: null,
  error: null,
});
export const sendCases = [
  [false, "startNow", "turn/start", "startNow"],
  [false, "guide", "turn/start", "startNow"],
  [true, "guide", "turn/steer", "guide"],
  [true, undefined, "turn/steer", "guide"],
  [true, "queue", "thread/queue/add", "queue"],
  [true, "startNow", undefined, undefined],
] as const;
export const queueCases = [
  ["editQueueItem", { queueItemId: "q1", newText: "edited" }, "thread/queue/update"],
  ["reorderQueueItem", { queueItemId: "q2", beforeQueueItemId: "q1" }, "thread/queue/reorder"],
  ["deleteQueueItem", { queueItemId: "q1" }, "thread/queue/delete"],
  ["sendQueuedNow", { queueItemId: "q2" }, "thread/queue/start"],
] as const;
export const firstTurnParams = {
  threadId: "created",
  clientUserMessageId: "create",
  input: textInput("First"),
  model: "native-model",
  effort: "high",
};
type Params = Record<string, unknown>;
type Handler = (params: Params) => unknown | Promise<unknown>;

export class MockRpc implements CodexRpcPort {
  readonly calls: { method: string; params: Params }[] = [];
  readonly replies: { id: string | number; result: unknown }[] = [];
  readonly errors: { id: string | number; error: { code: number; message: string } }[] = [];
  readonly handlers = new Map<string, Handler>();
  onRespond?: (id: string | number, result: unknown) => Promise<void>;
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: structuredClone((params ?? {}) as Params) });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Unmocked RPC: ${method}`);
    return structuredClone(await handler((params ?? {}) as Params)) as T;
  }
  async respond(id: string | number, result: unknown): Promise<void> {
    this.replies.push({ id, result: structuredClone(result) });
    await this.onRespond?.(id, result);
  }
  async respondError(id: string | number, error: { code: number; message: string }): Promise<void> {
    this.errors.push({ id, error });
  }
  params(method: string): Params[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function setup(t: TestContext, busy = false) {
  const root = await mkdtemp(join(tmpdir(), "codez-command-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpc = new MockRpc();
  const authority = { thread: threadFixture(), queue: [queued("q1"), queued("q2")] };
  if (busy) {
    authority.thread.status = { type: "active", activeFlags: [] };
    authority.thread.turns.push(turn());
  }
  const store = new ThreadStateStore(rpc, cwd);
  const state = store.markStarted(structuredClone(authority.thread));
  const ledger = new CommandLedger(root);
  const broker = new InteractionBroker(rpc, (id) => store.touch(id));
  const notices = new RewindNoticeStore();
  const context: CommandContext = {
    rpc,
    store,
    interactions: broker,
    ledger,
    workspaceId,
    rewindNotices: notices,
  };
  const router = new CommandRouter(context);
  rpc.handlers.set("thread/read", () => ({ thread: authority.thread }));
  rpc.handlers.set("thread/resume", () => ({ thread: authority.thread }));
  rpc.handlers.set("thread/turns/list", () => ({ data: authority.thread.turns, nextCursor: null }));
  rpc.handlers.set("thread/queue/list", () => ({ data: authority.queue, nextCursor: null }));
  rpc.handlers.set("turn/start", () => {
    const admitted = turn();
    authority.thread.turns.push(admitted);
    authority.thread.status = { type: "active", activeFlags: [] };
    return { turn: admitted };
  });
  rpc.handlers.set("turn/steer", () => ({ turnId: "live-turn" }));
  rpc.handlers.set("turn/interrupt", () => ({}));
  const command = (
    type: CommandType,
    payload: unknown = {},
    id: string = type,
    target: string | null = sessionId,
  ): CommandEnvelope => {
    const current = target ? store.get(target) : undefined;
    const value = {
      type,
      payload,
      commandId: id,
      clientId: "desktop-1",
      sessionId: target,
      issuedAt: 1000,
      ...(COMMANDS_REQUIRING_BASE_REVISION.has(type)
        ? { baseRevision: current?.revision ?? 0 }
        : {}),
      ...(ROW_TARGETING_COMMANDS.has(type) ? { baseLogEpoch: current?.epoch ?? "missing" } : {}),
    };
    assert.equal(parseCommandEnvelope(value).ok, true, "fixtures must validate before dispatch");
    return value;
  };
  const execute = async (value: CommandEnvelope) => {
    const ack = await router.execute(value);
    assert.deepEqual(commandAckSchema.parse(ack), ack);
    return ack;
  };
  return {
    rpc,
    authority,
    store,
    state,
    ledger,
    broker,
    notices,
    context,
    router,
    root,
    command,
    execute,
  };
}

export function queueMutations(h: Awaited<ReturnType<typeof setup>>) {
  const { rpc, authority } = h;
  rpc.handlers.set("thread/queue/add", (p) => {
    const item = {
      id: "native-added",
      clientUserMessageId: String(p.clientUserMessageId),
      input: p.input as ReturnType<typeof textInput>,
    };
    authority.queue.push(item);
    return { queuedSubmission: item };
  });
  rpc.handlers.set("thread/queue/update", (p) => {
    authority.queue = authority.queue.map((item) =>
      item.id === p.queuedSubmissionId
        ? { ...item, input: p.input as ReturnType<typeof textInput> }
        : item,
    );
    return {};
  });
  rpc.handlers.set("thread/queue/reorder", (p) => {
    authority.queue = (p.queuedSubmissionIds as string[]).map(
      (id) => authority.queue.find((item) => item.id === id)!,
    );
    return {};
  });
  for (const method of ["thread/queue/delete", "thread/queue/start"])
    rpc.handlers.set(method, (p) => {
      authority.queue = authority.queue.filter((item) => item.id !== p.queuedSubmissionId);
      return method.endsWith("/start") ? { turn: turn() } : {};
    });
}

export async function approval(h: Awaited<ReturnType<typeof setup>>, id = 45) {
  await h.broker.accept({
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: sessionId,
      turnId: "live-turn",
      itemId: "native-tool",
      command: "pwd",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  });
  return h.broker.list(sessionId).at(-1)!.interactionId;
}

/** Crash window: native RPC returned, but the durable result has not replaced pending/null. */
export async function crashAfterRpc(h: Awaited<ReturnType<typeof setup>>) {
  class CrashLedger extends CommandLedger {
    override async finish(): Promise<void> {
      throw new Error("simulated crash before ACK persistence");
    }
  }
  const router = new CommandRouter({ ...h.context, ledger: new CrashLedger(h.root) });
  await assert.rejects(
    router.execute(h.command("sendText", { text: "Unknown" }, "crashed")),
    /simulated crash/,
  );
  assert.equal(h.rpc.params("turn/start").length, 1);
}
