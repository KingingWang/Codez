import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CodexRpcPort, CodexServerRequest } from "../src/contract.js";
import { InteractionBroker } from "../src/interactions.js";
import {
  resolveQuestionAutoResolutionOptionsFromEnv,
  type QuestionAutoResolutionOptions,
} from "../src/interaction-auto-resolution.js";
import { handleControlRequest } from "../src/control-plane.js";

const START = 1_700_000_000_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function question(id = "question", threadId = "thread"): CodexServerRequest {
  return {
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId,
      turnId: "turn",
      itemId: id,
      questions: [
        { id: "target", header: "Target", question: "E2E_CSAQ34 Which target?", options: [] },
      ],
    },
  };
}
function fixture(t: TestContext, options: QuestionAutoResolutionOptions = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const changes: string[] = [];
  const errors: unknown[] = [];
  const rpc: CodexRpcPort = {
    async request<T>() {
      return {} as T;
    },
    async respond(id, result) {
      responses.push({ id, result });
    },
    async respondError() {},
  };
  const broker = new InteractionBroker(
    rpc,
    (id) => {
      changes.push(id);
    },
    undefined,
    {
      ...options,
      onError: (error) => errors.push(error),
    },
  );
  t.after(() => broker.close());
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await broker.whenSettled();
    await tick();
  };
  return { broker, rpc, responses, changes, errors, advance };
}

test("CSAQ34-01: native ordinary questions keep the V4 kind and fixed absolute 60s/300s phases", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question());
  const first = h.broker.list("thread")[0]!;
  assert.equal(first.kind, "userInput");
  assert.equal(first.payload.kind, "userInput");
  assert.equal(first.payload.toolName, "AskUserQuestion");
  assert.deepEqual(first.autoResolution, {
    state: "hiddenGrace",
    startedAt: START,
    visibleAt: START + 60_000,
    deadlineAt: START + 300_000,
  });
  await h.advance(59_000);
  assert.equal(first.autoResolution?.state, "hiddenGrace");
  await h.advance(1_000);
  assert.deepEqual(first.autoResolution, {
    state: "visibleCountdown",
    startedAt: START,
    visibleAt: START + 60_000,
    deadlineAt: START + 300_000,
  });
  await h.advance(120_000);
  assert.equal(first.autoResolution?.state, "visibleCountdown");
  assert.equal(h.responses.length, 0);
  await h.advance(119_000);
  assert.equal(h.responses.length, 0);
  await h.advance(1_000);
  assert.deepEqual(h.responses, [{ id: "question", result: { answers: {} } }]);
  assert.deepEqual(h.broker.list("thread"), []);
  assert.deepEqual(h.errors, []);
});

test("CSAQ34: a fallible history observer cannot cancel registration or flip a written response", async (t) => {
  const h = fixture(t, {
    onQuestion() {
      throw new Error("Synthetic history observer failure");
    },
  });
  await h.broker.accept(question());
  assert.equal(h.broker.list("thread")[0]!.autoResolution?.state, "hiddenGrace");
  await h.advance(300_000);
  assert.deepEqual(h.responses, [{ id: "question", result: { answers: {} } }]);
  assert.equal(h.errors.length, 2);
  assert.deepEqual(h.broker.list("thread"), []);
});

for (const elapsed of [0, 60_000, 299_000]) {
  test(`CSAQ34-03: first intent at ${elapsed}ms permanently snoozes and repeated snooze is noop`, async (t) => {
    const h = fixture(t);
    await h.broker.accept(question());
    await h.advance(elapsed);
    const id = h.broker.list("thread")[0]!.interactionId;
    assert.equal(await h.broker.snooze("other", id), false);
    assert.equal(await h.broker.snooze("thread", id), true);
    const snoozed = h.broker.list("thread")[0]!.autoResolution;
    assert.deepEqual(snoozed, { state: "snoozed", startedAt: START, snoozedAt: START + elapsed });
    const changes = h.changes.length;
    assert.equal(await h.broker.snooze("thread", id), false);
    assert.equal(h.changes.length, changes);
    await h.advance(600_000);
    assert.equal(h.responses.length, 0);
    await h.broker.resolve("thread", id, { action: "accept", content: { target: ["Chosen"] } });
    assert.deepEqual(h.responses, [
      { id: "question", result: { answers: { target: { answers: ["Chosen"] } } } },
    ]);
    assert.equal(await h.broker.snooze("thread", id), false);
  });
}

test("CSAQ34-02: disabling cancels all active and queued eligibility; re-enabling only affects new registrations", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question("first"));
  await h.broker.accept(question("queued"));
  await h.broker.accept(question("other-thread", "other"));
  await h.advance(60_000);
  assert.deepEqual(await h.broker.updatePreferences(false), {
    askUserQuestionAutoResolutionEnabled: false,
    snoozedInteractionCount: 2,
  });
  await h.broker.accept(question("registered-disabled"));
  await h.advance(300_000);
  assert.equal(h.responses.length, 0);
  assert.equal(h.broker.list("thread")[0]!.autoResolution?.state, "snoozed");
  assert.equal(h.broker.list("thread")[1]!.autoResolution, undefined);
  await h.broker.updatePreferences(true);
  await h.broker.accept(question("new"));
  for (const id of ["first", "queued", "registered-disabled"]) {
    const current = h.broker.list("thread")[0]!;
    if (current.payload.kind !== "userInput") assert.fail("Expected an ordinary question");
    assert.equal(current.payload.toolCallId, id);
    if (id !== "first") assert.equal(current.autoResolution, undefined);
    await h.broker.resolve("thread", current.interactionId, { freeText: "Chosen" });
  }
  assert.deepEqual(h.broker.list("thread")[0]!.autoResolution, {
    state: "hiddenGrace",
    startedAt: START + 360_000,
    visibleAt: START + 420_000,
    deadlineAt: START + 660_000,
  });
  assert.equal(h.broker.list("other")[0]!.autoResolution?.state, "snoozed");
  await h.advance(300_000);
  assert.deepEqual(h.responses.at(-1), { id: "new", result: { answers: {} } });
});

test("CSAQ34-04: only the same-thread head gets a full window; other threads remain independent", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question("first"));
  await h.broker.accept(question("second"));
  await h.broker.accept(question("parallel", "other"));
  assert.equal(h.broker.list("thread")[1]!.autoResolution, undefined);
  await h.advance(180_000);
  await h.broker.resolve("thread", h.broker.list("thread")[0]!.interactionId, { freeText: "A" });
  assert.deepEqual(h.broker.list("thread")[0]!.autoResolution, {
    state: "hiddenGrace",
    startedAt: START + 180_000,
    visibleAt: START + 240_000,
    deadlineAt: START + 480_000,
  });
  await h.advance(120_000);
  assert.deepEqual(h.responses.at(-1), { id: "parallel", result: { answers: {} } });
  assert.equal(h.broker.list("thread").length, 1);
  await h.advance(180_000);
  assert.deepEqual(h.responses.at(-1), { id: "second", result: { answers: {} } });
});

test("CSAQ34-04: disable admitted before a due callback wins, and deadline admitted first only responds once", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question("disable-first"));
  const disabled = h.broker.updatePreferences(false);
  t.mock.timers.tick(300_000);
  await disabled;
  await h.broker.whenSettled();
  assert.equal(h.responses.length, 0);
  assert.equal(h.broker.list("thread")[0]!.autoResolution?.state, "snoozed");
  await h.broker.resolved("thread", "disable-first");
  await h.broker.updatePreferences(true);
  await h.broker.accept(question("deadline-first"));
  t.mock.timers.tick(300_000);
  await h.broker.updatePreferences(false);
  assert.deepEqual(h.responses, [{ id: "deadline-first", result: { answers: {} } }]);
});

test("CSAQ34-03: an in-flight native response claims the request before a competing deadline or answer", async (t) => {
  const h = fixture(t);
  const gate = Promise.withResolvers<void>();
  h.rpc.respond = async (id, result) => {
    h.responses.push({ id, result });
    await gate.promise;
  };
  await h.broker.accept(question());
  const id = h.broker.list("thread")[0]!.interactionId;
  const answer = h.broker.resolve("thread", id, { freeText: "A" });
  await tick();
  t.mock.timers.tick(300_000);
  const duplicate = h.broker.resolve("thread", id, { freeText: "B" });
  const rejected = assert.rejects(duplicate, /stale|resolved/);
  gate.resolve();
  await answer;
  await rejected;
  await h.broker.whenSettled();
  assert.deepEqual(h.responses, [
    { id: "question", result: { answers: { target: { answers: ["A"] } } } },
  ]);
});

test("CSAQ34-03: an unknown native response outcome is reported without a retry", async (t) => {
  const h = fixture(t);
  h.rpc.respond = async (id, result) => {
    h.responses.push({ id, result });
    throw new Error("Synthetic transport failed after writing");
  };
  await h.broker.accept(question());
  const id = h.broker.list("thread")[0]!.interactionId;
  await h.advance(300_000);
  assert.equal(h.errors.length, 1);
  await h.advance(600_000);
  await assert.rejects(h.broker.resolve("thread", id, { freeText: "A" }), /stale|resolved/);
  assert.deepEqual(h.responses, [{ id: "question", result: { answers: {} } }]);
});

test("CSAQ34-06: permissions and MCP forms never time out or let a following question count down early", async (t) => {
  const h = fixture(t);
  await h.broker.accept({
    id: "permission",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "permission", command: "pwd" },
  });
  await h.broker.accept(question("behind-permission"));
  await h.broker.accept({
    id: "mcp",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "mcp-thread",
      serverName: "fixture",
      message: "Required form",
      requestedSchema: {},
    },
  });
  assert.equal(h.broker.list("thread")[0]!.autoResolution, undefined);
  assert.equal(h.broker.list("thread")[1]!.autoResolution, undefined);
  assert.equal(h.broker.list("mcp-thread")[0]!.autoResolution, undefined);
  await h.advance(600_000);
  assert.equal(h.responses.length, 0);
  await h.broker.resolve("thread", h.broker.list("thread")[0]!.interactionId, {
    optionId: "decline",
  });
  assert.equal(h.broker.list("thread")[0]!.autoResolution?.startedAt, START + 600_000);
});

for (const cleanup of ["answer", "cancel", "resolved", "expireTurn", "close"] as const) {
  test(`CSAQ34-08: ${cleanup} removes the deadline and no late callback writes a second result`, async (t) => {
    const h = fixture(t);
    await h.broker.accept(question());
    const id = h.broker.list("thread")[0]!.interactionId;
    if (cleanup === "answer") await h.broker.resolve("thread", id, { freeText: "A" });
    if (cleanup === "cancel") await h.broker.resolve("thread", id, { action: "cancel" });
    if (cleanup === "resolved") await h.broker.resolved("thread", "question");
    if (cleanup === "expireTurn") await h.broker.expireTurn("thread", "turn");
    if (cleanup === "close") h.broker.close();
    const responses = h.responses.length;
    await h.advance(600_000);
    assert.equal(h.responses.length, responses);
    assert.deepEqual(h.broker.list("thread"), []);
  });
}

test("CSAQ34: normal user answers still reject missing question content", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question());
  const id = h.broker.list("thread")[0]!.interactionId;
  await assert.rejects(
    h.broker.resolve("thread", id, { action: "accept", content: {} }),
    /requires an answer/,
  );
  assert.equal(h.responses.length, 0);
  await h.advance(300_000);
  assert.deepEqual(h.responses, [{ id: "question", result: { answers: {} } }]);
});

test("CSAQ34: native question IDs are data keys, including prototype property names", async (t) => {
  const h = fixture(t);
  await h.broker.accept({
    id: "special-ids",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "special-ids",
      questions: ["__proto__", "constructor"].map((id) => ({
        id,
        header: "ID",
        question: id,
        options: [],
      })),
    },
  });
  const content = Object.fromEntries([
    ["__proto__", ["A"]],
    ["constructor", ["B"]],
  ]);
  await h.broker.resolve("thread", h.broker.list("thread")[0]!.interactionId, { content });
  assert.deepEqual(h.responses, [
    {
      id: "special-ids",
      result: {
        answers: Object.fromEntries([
          ["__proto__", { answers: ["A"] }],
          ["constructor", { answers: ["B"] }],
        ]),
      },
    },
  ]);
});

test("CSAQ34-02: the strict control plane delegates to the real owner and retains complete remote scope", async (t) => {
  const h = fixture(t);
  await h.broker.accept(question());
  const workspace = {
    workspacePath: "/workspace",
    workspaceIdentity: "identity",
    workspaceKey: "identity",
    remoteSessionId: "remote",
  };
  const result = await handleControlRequest(
    "workspace/updateInteractionPreferences",
    {
      workspace,
      preferences: { askUserQuestionAutoResolutionEnabled: false },
    },
    { cwd: "/workspace", rpc: h.rpc, interactionPreferences: h.broker },
  );
  assert.deepEqual(result, {
    workspace,
    askUserQuestionAutoResolutionEnabled: false,
    snoozedInteractionCount: 1,
  });
  await assert.rejects(
    handleControlRequest(
      "workspace/updateInteractionPreferences",
      {
        workspace: { ...workspace, workspacePath: "/other" },
        preferences: { askUserQuestionAutoResolutionEnabled: true },
      },
      { cwd: "/workspace", rpc: h.rpc, interactionPreferences: h.broker },
    ),
    { code: -32602 },
  );
});

test("CSAQ34: the existing clock scale is test-only and cannot change production constants", () => {
  const scaled = { CODEZ_E2E_ASK_USER_QUESTION_CLOCK_SCALE: "20" };
  assert.equal(resolveQuestionAutoResolutionOptionsFromEnv(scaled), undefined);
  assert.equal(
    resolveQuestionAutoResolutionOptionsFromEnv({ ...scaled, CODEZ_ENV: "production" }),
    undefined,
  );
  assert.deepEqual(resolveQuestionAutoResolutionOptionsFromEnv({ ...scaled, CODEZ_ENV: "test" }), {
    hiddenGraceMs: 3_000,
    autoResolutionMs: 15_000,
  });
  for (const scale of ["0", "1001", "NaN"]) {
    assert.throws(
      () =>
        resolveQuestionAutoResolutionOptionsFromEnv({
          CODEZ_ENV: "test",
          CODEZ_E2E_ASK_USER_QUESTION_CLOCK_SCALE: scale,
        }),
      /between 1 and 1000/,
    );
  }
});
