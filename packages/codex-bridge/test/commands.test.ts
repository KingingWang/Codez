import assert from "node:assert/strict";
import test from "node:test";
import { projectThread } from "../src/projection.js";
import { CommandRouter } from "../src/commands.js";
import { CommandLedger } from "../src/command-ledger.js";
import { ThreadStateStore } from "../src/thread-state.js";
import { InteractionBroker } from "../src/interactions.js";
import { verifyHistoryChange } from "./fixtures/commands-history-fixture.js";
import { verifySandboxTransitions } from "./fixtures/commands-mode-fixture.js";
import { verifyNativeInputIntent } from "./fixtures/commands-intent-fixture.js";
import { verifyCreateIntent } from "./fixtures/commands-create-fixture.js";
import {
  setup,
  approval,
  queueMutations,
  deferred,
  cwd,
  workspaceId,
  sessionId,
  selection,
  attachment,
  textInput,
  queued,
  turn,
  sendCases,
  queueCases,
  firstTurnParams,
  crashAfterRpc,
} from "./fixtures/commands-fixture.js";
test("create maps native provider/model and first-input command correlation", async (t) => {
  for (const firstInput of [undefined, { text: "First", modelSelection: selection }])
    await t.test(firstInput ? "with first input" : "empty", async (t) => {
      const h = await setup(t);
      h.rpc.handlers.set("thread/settings/update", () => ({}));
      h.rpc.handlers.set("thread/start", () => ({
        thread: { ...h.authority.thread, id: "created", model: null, turns: [] },
        model: "effective-model",
        reasoningEffort: "high",
      }));
      const command = h.command(
        "createSession",
        { workspaceId, config: { modelSelection: selection }, firstInput },
        "create",
        null,
      );
      const ack = await h.execute(command);
      assert.equal(ack.status, "accepted");
      assert.deepEqual(h.rpc.params("thread/start"), [
        { cwd, historyMode: "paginated", model: "native-model", modelProvider: "openai" },
      ]);
      const model = firstInput ? "native-model" : "effective-model";
      assert.equal(h.store.get("created")?.thread.model, model);
      assert.equal(h.store.get("created")?.thread.reasoningEffort, "high");
      assert.deepEqual(h.rpc.params("turn/start"), firstInput ? [firstTurnParams] : []);
      assert.deepEqual(await h.execute(command), ack);
      assert.equal(h.rpc.params("thread/start").length, 1);
    });
});
test("create honors settings and rejects unsupported intent", verifyCreateIntent);
test("sandbox transitions change native permissions only when intended", verifySandboxTransitions);
test("create rejects another workspace before any native mutation", async (t) => {
  const h = await setup(t);
  const ack = await h.execute(h.command("createSession", { workspaceId: "other" }, "create", null));
  assert.equal(ack.status, "failed");
  assert.deepEqual(h.rpc.calls, []);
});
test("native input intent is never silently lost", verifyNativeInputIntent);
test("replayable bot sendText payload (heldQueueDisposition + selection) is admitted", async (t) => {
  // Host codezTaskServiceAdapter 的 replayable sendText 载荷形状：
  // { text, heldQueueDisposition: "keepQueueAndSend", modelSelection }，
  // 不带 mode/plan/attachments。回归：bridge 曾以 held queue 为由整体拒绝该载荷，
  // 导致所有 Bot/Automation/手机消息在 admission 前失败。
  const h = await setup(t);
  const ack = await h.execute(
    h.command("sendText", {
      text: "hi",
      heldQueueDisposition: "keepQueueAndSend",
      modelSelection: {
        providerId: "openai",
        modelId: "fixture-model",
        options: { reasoningLevel: "medium" },
      },
    }),
  );
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(h.rpc.params("turn/start"), [
    {
      threadId: sessionId,
      input: textInput("hi"),
      clientUserMessageId: "sendText",
      model: "fixture-model",
      effort: "medium",
    },
  ]);

  // running 时同一载荷走默认 guide（turn/steer），settings 不变不得拒绝。
  const busy = await setup(t, true);
  const steered = await busy.execute(
    busy.command("sendText", {
      text: "继续",
      heldQueueDisposition: "keepQueueAndSend",
      modelSelection: {
        providerId: "openai",
        modelId: "fixture-model",
        options: { reasoningLevel: "medium" },
      },
    }),
  );
  assert.equal(steered.status, "accepted", steered.message);
  assert.deepEqual(busy.rpc.methods(), ["turn/steer"]);
});
test("bot createSession config (provider/model/thought + forced yolo) maps to native thread", async (t) => {
  // Bot createTask(v4Create) 的载荷形状：config 携带 provider/model/thought，
  // mode 由 applyDraftConfigOptions 随后经 switchCollaborationMode 强制 yolo。
  const h = await setup(t);
  h.rpc.handlers.set("thread/settings/update", () => ({}));
  h.rpc.handlers.set("thread/start", () => ({
    thread: { ...h.authority.thread, id: "created", model: null, turns: [] },
    model: "deepseek-v4-flash",
    reasoningEffort: "xhigh",
  }));
  const ack = await h.execute(
    h.command(
      "createSession",
      {
        workspaceId,
        config: { provider: "ollama1", model: "deepseek-v4-flash", thought: "xhigh" },
      },
      "create",
      null,
    ),
  );
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(h.rpc.params("thread/start"), [
    {
      cwd,
      historyMode: "paginated",
      model: "deepseek-v4-flash",
      modelProvider: "ollama1",
    },
  ]);
  assert.deepEqual(h.rpc.params("thread/settings/update"), [
    { threadId: "created", effort: "xhigh" },
  ]);

  const mode = await h.execute(
    h.command("switchCollaborationMode", { mode: "yolo" }, "yolo", "created"),
  );
  assert.equal(mode.status, "accepted", mode.message);
  const updates = h.rpc.params("thread/settings/update");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], {
    threadId: "created",
    collaborationMode: {
      mode: "default",
      settings: {
        model: "deepseek-v4-flash",
        reasoning_effort: "xhigh",
        developer_instructions: null,
      },
    },
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});
test("send startNow/guide/queue decisions use native turn/queue authority", async (t) => {
  for (const [busy, delivery, method, accepted] of sendCases)
    await t.test(`${busy}:${delivery}`, async (t) => {
      const h = await setup(t, busy);
      queueMutations(h);
      const ack = await h.execute(
        h.command("sendText", { text: "Hello", requestedDelivery: delivery }, "send"),
      );
      assert.equal(ack.status, method ? "accepted" : "failed");
      if (!method) {
        assert.deepEqual(h.rpc.calls, []);
        return;
      }
      assert.deepEqual(ack.result, { type: "inputAccepted", delivery: accepted, inputId: "send" });
      const params = h.rpc.params(method)[0]!;
      assert.deepEqual(params.input, textInput("Hello"));
      assert.equal(params.clientUserMessageId, "send");
      assert.equal(params.threadId, sessionId);
      if (method === "turn/steer") assert.equal(params.expectedTurnId, "live-turn");
      assert.deepEqual(h.state.queue, delivery === "queue" ? h.authority.queue : []);
    });
});
test("queue CRUD/reorder/start read native list, retain external entries, never use turn/start", async (t) => {
  const h = await setup(t);
  queueMutations(h);
  await h.store.refreshQueue(sessionId);
  for (const [type, payload, native] of queueCases) {
    const ack = await h.execute(h.command(type, payload));
    assert.equal(ack.status, "accepted");
    assert.equal(h.rpc.params(native).length, 1);
    assert.deepEqual(h.state.queue, h.authority.queue);
  }
  assert.deepEqual(h.rpc.params("thread/queue/reorder")[0]?.queuedSubmissionIds, ["q2", "q1"]);
  assert.equal(h.rpc.params("turn/start").length, 0);
  assert.equal(h.rpc.methods().at(-1), "thread/queue/list");
  h.authority.queue = [queued("external-after-restart")];
  await h.store.refreshQueue(sessionId);
  assert.equal(
    projectThread(h.state.thread, { workspacePath: cwd, queue: h.state.queue }).queue.items[0]
      ?.clientId,
    "codex-external",
  );
});
test("stop checks expectedTurn and cannot interrupt a later run", async (t) => {
  const h = await setup(t, true);
  const stale = await h.execute(
    h.command("stop", { expectedForegroundExecutionId: "old-turn" }, "stale-stop"),
  );
  assert.equal(stale.status, "failed");
  assert.deepEqual(h.rpc.calls, []);
  const command = h.command("stop", { expectedForegroundExecutionId: "live-turn" }, "stop");
  assert.equal((await h.execute(command)).status, "accepted");
  await h.execute(command);
  assert.deepEqual(h.rpc.params("turn/interrupt"), [{ threadId: sessionId, turnId: "live-turn" }]);
});

test("CAS rejects stale revision/epoch and invalid envelopes without side effects", async (t) => {
  const h = await setup(t);
  for (const [id, override] of [
    ["revision", { baseRevision: 0 }],
    ["epoch", { baseLogEpoch: "old-epoch" }],
  ] as const) {
    const ack = await h.execute({
      ...h.command(
        "forkAssistant",
        { target: { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" } },
        id,
      ),
      ...override,
    });
    assert.equal(ack.status, "stale");
    assert.equal(ack.revisionAtDecision, h.state.revision);
  }
  await assert.rejects(
    h.router.execute({
      ...h.command("editQueueItem", { queueItemId: "q1", newText: "x" }),
      baseRevision: undefined,
    }),
    /Invalid/,
  );
  assert.deepEqual(h.rpc.calls, []);
});

test("simultaneous duplicate sends wait for one native RPC and replay durable ACK after restart", async (t) => {
  const h = await setup(t);
  const entered = deferred();
  const release = deferred();
  h.rpc.handlers.set("turn/start", async () => {
    entered.resolve();
    await release.promise;
    return { turn: turn() };
  });
  const command = h.command("sendText", { text: "Once" }, "same");
  const first = h.execute(command);
  await entered.promise;
  const second = h.execute(command);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "accepted");
  assert.deepEqual(a, b);
  const restarted = new CommandRouter({ ...h.context, ledger: new CommandLedger(h.root) });
  assert.deepEqual(await restarted.execute(command), a);
  assert.equal(h.rpc.params("turn/start").length, 1);
});

test("pending crash ledger prevents all native retries and preserves session-scoped keys", async (t) => {
  const h = await setup(t);
  await crashAfterRpc(h);
  const restarted = new CommandRouter({ ...h.context, ledger: new CommandLedger(h.root) });
  const ack = await restarted.execute(h.command("sendText", { text: "Unknown" }, "crashed"));
  assert.equal(ack.reasonCode, "codex.commandOutcomeUnknown");
  assert.deepEqual(h.rpc.methods(), ["turn/start"]);
  assert.equal(await h.ledger.lookup(null, "crashed"), undefined);
  assert.equal(await h.ledger.lookup(sessionId, "crashed"), "unknown");
});

test("native rejection is surfaced and duplicate delivery never retries an ambiguous mutation", async (t) => {
  const h = await setup(t);
  h.rpc.handlers.set("turn/start", async () => {
    await Promise.resolve();
    throw new Error("connection lost after admission");
  });
  const command = h.command("sendText", { text: "Once" });
  const ack = await h.execute(command);
  assert.equal(ack.status, "failed");
  assert.match(ack.message ?? "", /connection lost/);
  assert.deepEqual(await h.execute(command), ack);
  assert.equal(h.rpc.params("turn/start").length, 1);
});

test("fork resolves stable row+entity to native turn and rejects stale target identity", async (t) => {
  const h = await setup(t);
  h.rpc.handlers.set("thread/fork", () => ({ thread: { ...h.authority.thread, id: "forked" } }));
  const bad = await h.execute(
    h.command("forkAssistant", { target: { rowId: 3, entityId: "wrong" } }, "bad-fork"),
  );
  assert.equal(bad.status, "failed");
  assert.deepEqual(h.rpc.calls, []);
  const ack = await h.execute(
    h.command("forkAssistant", {
      target: { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" },
    }),
  );
  assert.equal(ack.status, "accepted");
  assert.deepEqual(h.rpc.params("thread/fork"), [{ threadId: sessionId, lastTurnId: "turn-1" }]);
  assert.equal(h.store.get("forked")?.thread.id, "forked");
});

test("unsupported file rewind fails closed without destructive RPC", async (t) => {
  const h = await setup(t);
  for (const type of ["applyFileRewind", "editUserQuery"] as const) {
    const ack = await h.execute(
      h.command(type, {
        target: { rowId: 1, entityId: "codex:turn:turn-1:item:user-1" },
        newText: "edit",
        workspaceMode: "rewind",
      }),
    );
    assert.equal(ack.status, "failed");
    assert.match(ack.message ?? "", /does not support/);
  }
  assert.deepEqual(h.rpc.calls, []);
});
test("history edit/retry preserve files, hydrate the correct prefix and rotate epoch", async (t) => {
  for (const type of ["editUserQuery", "retryTurn"] as const)
    await t.test(type, (t) => verifyHistoryChange(t, type));
});
test("approval accept/decline/cancel routes exact reverse request once through broker", async (t) => {
  const h = await setup(t, true);
  for (const [index, optionId] of ["accept", "decline", "cancel"].entries()) {
    const interactionId = await approval(h, index);
    const command = h.command(
      "resolveInteraction",
      { interactionId, answer: { optionId } },
      `resolve-${index}`,
    );
    assert.equal((await h.execute(command)).status, "accepted");
    await h.execute(command);
    assert.deepEqual(h.rpc.replies[index], { id: index, result: { decision: optionId } });
  }
  assert.equal(h.rpc.replies.length, 3);
  assert.deepEqual(h.broker.list(sessionId), []);
  const interactionId = await approval(h, 99);
  h.broker.expireTurn(sessionId, "live-turn");
  assert.equal(
    (
      await h.execute(
        h.command("resolveInteraction", { interactionId, answer: { optionId: "accept" } }, "late"),
      )
    ).status,
    "failed",
  );
  assert.equal(h.rpc.replies.length, 3);
});

test("approval write failure is awaited and cannot be retried under a new command ID", async (t) => {
  const h = await setup(t, true);
  const interactionId = await approval(h);
  h.rpc.onRespond = async () => {
    await Promise.resolve();
    throw new Error("approval reply lost");
  };
  for (const id of ["answer", "second-answer"]) {
    const ack = await h.execute(
      h.command("resolveInteraction", { interactionId, answer: { optionId: "accept" } }, id),
    );
    assert.equal(ack.status, "failed");
  }
  assert.equal(h.rpc.replies.length, 1);
});

test("attachment resolver is awaited and its async errors prevent native send", async (t) => {
  const h = await setup(t);
  const entered = deferred();
  const release = deferred<unknown[]>();
  h.context.attachments = async (refs, id) => {
    assert.deepEqual(refs, [attachment]);
    assert.equal(id, sessionId);
    entered.resolve();
    return release.promise;
  };
  const pending = h.execute(h.command("sendText", { text: "Look", attachments: [attachment] }));
  await entered.promise;
  assert.deepEqual(h.rpc.calls, []);
  release.reject(new Error("staging failed"));
  const ack = await pending;
  assert.equal(ack.status, "failed");
  assert.match(ack.message ?? "", /staging failed/);
  assert.deepEqual(h.rpc.calls, []);
});

test("cross-provider send cannot silently execute under the existing provider", async (t) => {
  const h = await setup(t);
  const ack = await h.execute(
    h.command("sendText", {
      text: "Different provider",
      modelSelection: { ...selection, providerId: "other-provider" },
    }),
  );
  assert.equal(
    ack.status,
    "failed",
    "turn/start has no modelProvider override; unsupported changes must reject",
  );
  assert.deepEqual(h.rpc.calls, []);
});

test("plan collaboration settings preserve the explicit reasoning effort", async (t) => {
  const h = await setup(t);
  const ack = await h.execute(
    h.command("sendText", { text: "Plan", modelSelection: selection, mode: "plan" }),
  );
  assert.equal(ack.status, "accepted");
  const params = h.rpc.params("turn/start")[0]!;
  assert.equal(params.effort, "high");
  assert.deepEqual(params.collaborationMode, {
    mode: "plan",
    settings: { model: "native-model", reasoning_effort: "high", developer_instructions: null },
  });
});

test("distinct sends before TurnStarted notification do not dispatch two native starts", async (t) => {
  const h = await setup(t);
  const a = h.execute(h.command("sendText", { text: "First" }, "first"));
  const b = h.execute(h.command("sendText", { text: "Second" }, "second"));
  const acks = await Promise.all([a, b]);
  assert.equal(acks[0]?.status, "accepted");
  assert.equal(
    h.rpc.params("turn/start").length,
    1,
    "the native response already identifies the admitted active turn",
  );
  if (acks[1]?.status === "accepted")
    assert.equal(h.rpc.params("turn/steer")[0]?.expectedTurnId, "live-turn");
});

test("model switch followed by mode switch cannot restore stale cached model", async (t) => {
  const h = await setup(t);
  h.rpc.handlers.set("thread/settings/update", (p) => {
    if (typeof p.model === "string") h.authority.thread.model = p.model;
    return {};
  });
  assert.equal(
    (
      await h.execute(
        h.command("switchModelConfig", { provider: "openai", model: "new-model", thought: "high" }),
      )
    ).status,
    "accepted",
  );
  assert.equal(
    (await h.execute(h.command("switchCollaborationMode", { mode: "plan" }))).status,
    "accepted",
  );
  assert.deepEqual(h.rpc.params("thread/settings/update")[0], {
    threadId: sessionId,
    model: "new-model",
    effort: "high",
  });
  const p = h.rpc.params("thread/settings/update")[1]!;
  assert.equal(
    (p.collaborationMode as { settings: { model: string } }).settings.model,
    "new-model",
  );
});

test("resume retains model metadata from native response for subsequent mode requests", async (t) => {
  const h = await setup(t);
  h.rpc.handlers.set("thread/resume", () => ({
    thread: { ...h.authority.thread, model: null },
    model: "resumed-model",
    reasoningEffort: "high",
  }));
  const store = new ThreadStateStore(h.rpc, cwd);
  const state = await store.ensure(sessionId);
  assert.equal(state.thread.model, "resumed-model");
  assert.equal(state.thread.reasoningEffort, "high");
});

test("async broker publication failures are not silently detached", async (t) => {
  const h = await setup(t);
  const failedPublication = Promise.reject(new Error("snapshot publish failed"));
  void failedPublication.catch(() => {}); // Attach observation without hiding the broker's required rejection.
  const broker = new InteractionBroker(h.rpc, () => failedPublication);
  await assert.rejects(
    broker.accept({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        turnId: "live-turn",
        itemId: "tool",
        command: "pwd",
      },
    }),
    /snapshot publish failed/,
  );
});
