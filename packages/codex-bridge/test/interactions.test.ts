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

test("object approval decisions preserve native order and return the stored object unchanged", async () => {
  const { broker, responses } = setup();
  const execDecision = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
  };
  const allowExample = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "example.com", action: "allow" },
    },
  };
  const allowMirror = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "mirror.example", action: "allow" },
    },
  };
  const denyAds = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "ads.example", action: "deny" },
    },
  };
  await broker.accept({
    id: "object-rpc",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "curl https://example.com",
      availableDecisions: ["decline", execDecision, allowExample, allowMirror, denyAds, "cancel"],
    },
  });
  const pending = broker.list("thread")[0]!;
  assert.equal(pending.payload.kind, "permission");
  assert.deepEqual(
    pending.payload.kind === "permission"
      ? pending.payload.options.map(({ optionId, label }) => [optionId, label])
      : [],
    [
      ["decline", "Deny"],
      [
        "acceptWithExecpolicyAmendment:0",
        "Yes, and don't ask again for commands that start with …",
      ],
      ["applyNetworkPolicyAmendment:0", "Yes, and allow this host in the future"],
      ["applyNetworkPolicyAmendment:1", "Yes, and allow this host in the future"],
      ["applyNetworkPolicyAmendment:2", "No, and block this host in the future"],
      ["cancel", "Cancel turn"],
    ],
  );

  await broker.resolve("thread", pending.interactionId, {
    optionId: "acceptWithExecpolicyAmendment:0",
    content: { execpolicy_amendment: ["renderer", "must", "not", "amend"] },
  });
  assert.deepEqual(responses, [{ id: "object-rpc", result: { decision: execDecision } }]);

  const stale = broker.list("thread")[0]!;
  assert.equal(stale, undefined);
  await assert.rejects(
    broker.resolve("thread", pending.interactionId, {
      optionId: "acceptWithExecpolicyAmendment:0",
    }),
    /stale/,
  );
});

test("duplicate native network decisions use unique option ids and resolve to their own objects", async () => {
  const { broker, responses } = setup();
  const first = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "example.com", action: "allow" },
    },
  };
  const second = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "mirror.example", action: "deny" },
    },
  };
  for (const [id, decision] of [
    ["first-rpc", first],
    ["second-rpc", second],
  ] as const) {
    await broker.accept({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        availableDecisions: [decision],
      },
    });
  }
  const interactions = broker.list("thread");
  assert.deepEqual(
    interactions.flatMap((interaction) =>
      interaction.payload.kind === "permission"
        ? interaction.payload.options.map(({ optionId }) => optionId)
        : [],
    ),
    ["applyNetworkPolicyAmendment:0", "applyNetworkPolicyAmendment:0"],
  );
  await assert.rejects(
    broker.resolve("thread", interactions[1]!.interactionId, {
      optionId: "applyNetworkPolicyAmendment:1",
    }),
    /not offered/,
  );
  await broker.resolve("thread", interactions[0]!.interactionId, {
    optionId: "applyNetworkPolicyAmendment:0",
  });
  await broker.resolve("thread", interactions[1]!.interactionId, {
    optionId: "applyNetworkPolicyAmendment:0",
  });
  assert.deepEqual(responses, [
    { id: "first-rpc", result: { decision: first } },
    { id: "second-rpc", result: { decision: second } },
  ]);
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

test("forged or expired object approval option ids fail closed", async () => {
  const { broker, responses } = setup();
  const decision = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "example.com", action: "allow" },
    },
  };
  await broker.accept({
    id: 100,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      availableDecisions: [decision],
    },
  });
  const interaction = broker.list("thread")[0]!;
  for (const optionId of [
    "acceptWithExecpolicyAmendment",
    "applyNetworkPolicyAmendment",
    "applyNetworkPolicyAmendment:1",
    "accept",
  ]) {
    await assert.rejects(
      broker.resolve("thread", interaction.interactionId, { optionId }),
      /not offered/,
    );
  }
  await broker.resolve("thread", interaction.interactionId, {
    optionId: "applyNetworkPolicyAmendment:0",
    content: { network_policy_amendment: { host: "renderer.example", action: "deny" } },
  });
  assert.deepEqual(responses, [{ id: 100, result: { decision } }]);
  await broker.expireTurn("thread", "turn");
  await assert.rejects(
    broker.resolve("thread", interaction.interactionId, {
      optionId: "applyNetworkPolicyAmendment:0",
    }),
    /stale/,
  );
});

test("missing native decision list keeps the compatible default options", async () => {
  const { broker, responses } = setup();
  await broker.accept({
    id: "defaults",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item", command: "pwd" },
  });
  const interaction = broker.list("thread")[0]!;
  assert.deepEqual(
    interaction.payload.kind === "permission"
      ? interaction.payload.options.map(({ optionId }) => optionId)
      : [],
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  await broker.resolve("thread", interaction.interactionId, { optionId: "accept" });
  for (const [optionId, expected] of [
    ["accept", "accept"],
    ["acceptForSession", "acceptForSession"],
    ["decline", "decline"],
    ["cancel", "cancel"],
  ] as const) {
    await broker.accept({
      id: optionId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        availableDecisions: [optionId],
      },
    });
    await broker.resolve("thread", broker.list("thread")[0]!.interactionId, { optionId });
    assert.deepEqual(responses.at(-1), { id: optionId, result: { decision: expected } });
  }
});
