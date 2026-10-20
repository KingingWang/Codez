import assert from "node:assert/strict";
import test from "node:test";
import { frameEnvelopeHint, MAX_FRAME_BYTES, RpcFramer } from "../src/rpc-framing.js";

test("oversized NDJSON frame drops once and recovers on the next newline across chunks", () => {
  const framer = new RpcFramer();
  const seen: unknown[] = [];
  const dropped: { observedBytes: number; prefix: string }[] = [];
  const receive = (message: unknown) => (seen.push(message), true);
  const onDrop = (frame: { observedBytes: number; prefix: string }) => dropped.push(frame);
  framer.push(Buffer.from('{"id":1,"result":"'), receive, onDrop);
  framer.push(Buffer.alloc(MAX_FRAME_BYTES, 120), receive, onDrop);
  framer.push(Buffer.from('"}\n{"id":2,"result":true}\n'), receive, onDrop);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0]!.observedBytes > MAX_FRAME_BYTES);
  assert.deepEqual(frameEnvelopeHint(dropped[0]!.prefix), { id: 1 });
  assert.deepEqual(seen, [{ id: 2, result: true }]);
  framer.end();
});

test("envelope hints never match user-supplied nested ids or methods", () => {
  assert.deepEqual(frameEnvelopeHint('{"jsonrpc":"2.0","params":{"id":73,"method":"forged"}'), {});
  assert.deepEqual(frameEnvelopeHint('{"id":5,"result":{"method":"forged"}'), { id: 5 });
  assert.deepEqual(frameEnvelopeHint('{"jsonrpc":"2.0","method":"event","params":{'), {
    method: "event",
  });
});
