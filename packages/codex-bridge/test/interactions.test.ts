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
