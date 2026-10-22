import assert from "node:assert/strict";
import test from "node:test";
import { InteractionBroker } from "../src/interactions.js";
import type { CodexRpcPort } from "../src/contract.js";

function setup() {
  const responses: unknown[] = [];
  const rpc: CodexRpcPort = {
    async request<T>() {
      return {} as T;
    },
    async respond(id, result) {
      responses.push({ id, result });
    },
    async respondError(id, error) {
      responses.push({ id, error });
    },
  };
  return { broker: new InteractionBroker(rpc, () => {}), responses };
}
test("approval preserves reverse request id and rejects cross-thread or duplicate replies", async () => {
  const { broker, responses } = setup();
  await broker.accept({
    id: 45,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "pwd",
      availableDecisions: ["accept", "decline"],
    },
  });
  const pending = broker.list("thread")[0]!;
  assert.equal(pending.turnId, "turn");
  const id = pending.interactionId;
  await assert.rejects(broker.resolve("other", id, { optionId: "accept" }), /stale/);
  await broker.resolve("thread", id, { optionId: "accept" });
  assert.deepEqual(responses, [{ id: 45, result: { decision: "accept" } }]);
  await assert.rejects(broker.resolve("thread", id, { optionId: "accept" }), /stale/);
});
test("question answers preserve native question ids", async () => {
  const { broker, responses } = setup();
  await broker.accept({
    id: "rpc",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      questions: [
        {
          id: "flavor",
          question: "Which?",
          header: "Flavor",
          options: [{ label: "A", description: "Alpha" }],
        },
      ],
    },
  });
  await broker.resolve("thread", broker.list("thread")[0]!.interactionId, { freeText: "A" });
  assert.deepEqual(responses, [{ id: "rpc", result: { answers: { flavor: { answers: ["A"] } } } }]);
});

test("native MCP tool approval offers choices instead of free text and replies with the selected action", async () => {
  const { broker, responses } = setup();
  const params = {
    threadId: "thread",
    turnId: "turn",
    serverName: "codez-desktop-browser-cua",
    mode: "form",
    message: 'Allow the codez-desktop-browser-cua MCP server to run tool "cua_status"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
  };
  await broker.accept({ id: "allow-rpc", method: "mcpServer/elicitation/request", params });
  const pending = broker.list("thread")[0]!;
  assert.equal(pending.turnId, "turn");
  assert.equal(pending.payload.kind, "permission");
  if (pending.payload.kind === "permission") {
    assert.equal(pending.payload.toolName, "mcp__codez-desktop-browser-cua__cua_status");
  }
  assert.deepEqual(
    pending.payload.kind === "permission"
      ? pending.payload.options.map(({ optionId }) => optionId)
      : [],
    ["accept", "acceptForSession", "acceptAlways", "cancel"],
  );
  await assert.rejects(
    broker.resolve("thread", pending.interactionId, { freeText: "allow" }),
    /not offered/,
  );
  await broker.resolve("thread", pending.interactionId, { optionId: "accept" });
  assert.deepEqual(responses, [
    { id: "allow-rpc", result: { action: "accept", content: null, _meta: null } },
  ]);
  await assert.rejects(
    broker.resolve("thread", pending.interactionId, { optionId: "accept" }),
    /stale/,
  );

  for (const [optionId, expected] of [
    ["acceptForSession", { action: "accept", content: null, _meta: { persist: "session" } }],
    ["acceptAlways", { action: "accept", content: null, _meta: { persist: "always" } }],
    ["cancel", { action: "cancel", content: null, _meta: null }],
  ] as const) {
    await broker.accept({ id: optionId, method: "mcpServer/elicitation/request", params });
    await broker.resolve("thread", broker.list("thread")[0]!.interactionId, { optionId });
    assert.deepEqual(responses.at(-1), { id: optionId, result: expected });
  }
});

test("MCP tool approval cannot invent persistence; ordinary MCP forms remain user input", async () => {
  const { broker, responses } = setup();
  const params = {
    threadId: "thread",
    serverName: "test-server",
    mode: "form",
    message: "Allow this tool?",
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", persist: "session" },
  };
  await broker.accept({ id: 1, method: "mcpServer/elicitation/request", params });
  const pending = broker.list("thread")[0]!;
  assert.equal(pending.payload.kind, "permission");
  assert.deepEqual(
    pending.payload.kind === "permission"
      ? pending.payload.options.map(({ optionId }) => optionId)
      : [],
    ["accept", "acceptForSession", "cancel"],
  );
  await assert.rejects(
    broker.resolve("thread", pending.interactionId, { optionId: "acceptAlways" }),
    /not offered/,
  );
  await broker.resolve("thread", pending.interactionId, { optionId: "cancel" });
  assert.deepEqual(responses, [
    { id: 1, result: { action: "cancel", content: null, _meta: null } },
  ]);

  for (const [id, override] of [
    [2, { _meta: {}, requestedSchema: params.requestedSchema }],
    [
      3,
      {
        _meta: params._meta,
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      },
    ],
  ] as const) {
    await broker.accept({
      id,
      method: "mcpServer/elicitation/request",
      params: { ...params, ...override },
    });
    const ordinary = broker.list("thread")[0]!;
    assert.equal(ordinary.payload.kind, "userInput");
    await broker.resolve("thread", ordinary.interactionId, {
      action: "accept",
      content: { name: "ok" },
    });
    assert.deepEqual(responses.at(-1), {
      id,
      result: { action: "accept", content: { name: "ok" }, _meta: null },
    });
  }
});
test("unknown reverse methods fail closed", async () => {
  const { broker, responses } = setup();
  await broker.accept({ id: 9, method: "new/unsafe", params: {} });
  assert.equal((responses[0] as { error: { code: number } }).error.code, -32601);
});

test("native resolution clears the exact prompt without answering it again", async () => {
  const { broker, responses } = setup();
  await broker.accept({
    id: "resolved",
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item" },
  });
  const id = broker.list("thread")[0]!.interactionId;
  await broker.resolved("other", "resolved");
  assert.equal(broker.list("thread").length, 1);
  await broker.resolved("thread", "resolved");
  assert.equal(broker.list("thread").length, 0);
  await assert.rejects(broker.resolve("thread", id, { optionId: "accept" }), /stale/);
  assert.deepEqual(responses, []);
});

test("an explicit empty native decision list cannot gain implicit approval options", async () => {
  const { broker } = setup();
  await broker.accept({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      availableDecisions: [],
    },
  });
  const interaction = broker.list("thread")[0]!;
  assert.equal(interaction.payload.kind, "permission");
  await assert.rejects(
    broker.resolve("thread", interaction.interactionId, { optionId: "accept" }),
    /not offered/,
  );
});
