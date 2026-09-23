import assert from "node:assert/strict";
import { test } from "node:test";
import { queueStateSchema } from "@codez/shared/codez-protocol-v4";
import { projectCodexQueue, projectQueue, projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

function queueFixture() {
  return {
    data: [
      {
        id: "queue-1",
        clientUserMessageId: "command-queue-1",
        input: [{ type: "text", text: "Queued text", text_elements: [] }],
      },
    ],
    nextCursor: null,
  };
}

const admissions = {
  "queue-1": { clientId: "desktop-1", admittedAt: 115000, order: { admissionSeq: 9 } },
};

test("native queue projection preserves pagination and command correlation without storing state", () => {
  const queue = queueFixture();
  assert.deepEqual(projectCodexQueue(queue), queue);
  assert.deepEqual(projectCodexQueue({ ...queue, nextCursor: "next" }).nextCursor, "next");
  assert.deepEqual(projectCodexQueue(queue.data), queue);
  const result = projectCodexQueue(queue);
  result.data.splice(0, 1);
  assert.equal(queue.data.length, 1);
  assert.equal(projectCodexQueue(queue).data.length, 1);
});

test("V4 queue uses real admission metadata or explicit unavailable sentinels, not list-derived facts", () => {
  const queue = queueFixture();
  const result = projectQueue(queue, admissions);
  assert.deepEqual(queueStateSchema.parse(result), result);
  assert.equal(result.items[0]?.sourceCommandId, "command-queue-1");
  assert.equal(result.items[0]?.clientId, "desktop-1");
  assert.equal(result.items[0]?.order.admissionSeq, 9);
  assert.equal(result.items[0]?.order.queuePosition, 0);
  assert.equal(result.items[0]?.admittedAt, 115000);
  assert.equal(result.autoDrain, false);
  const external = projectQueue(queue).items[0];
  assert.equal(external?.clientId, "codex-external");
  assert.equal(external?.admittedAt, 0);
  assert.equal(external?.order.admissionSeq, 0);
  assert.equal(external?.order.queuePosition, 0);
  assert.equal(external?.sourceCommandId, "command-queue-1");
  assert.throws(() => projectQueue({ ...queue, nextCursor: "next" }, admissions), /all pages/);
  assert.throws(
    () => projectCodexQueue({ ...queue, data: [...queue.data, ...queue.data] }),
    /Duplicate/,
  );
  assert.deepEqual(projectQueue([], admissions), { items: [], autoDrain: false });
});

test("conversation consumes exactly the latest caller-supplied native queue", () => {
  const thread = threadFixture();
  const options = {
    workspacePath: "/workspace",
    queue: queueFixture(),
    queueAdmissions: admissions,
  };
  assert.equal(projectThread(thread, options).queue.items.length, 1);
  assert.equal(projectThread(thread, { ...options, queue: [] }).queue.items.length, 0);
  const recovered = projectThread(thread, { ...options, queueAdmissions: {} });
  assert.equal(recovered.queue.items[0]?.text, "Queued text");
  assert.equal(recovered.queue.items[0]?.clientId, "codex-external");
});
