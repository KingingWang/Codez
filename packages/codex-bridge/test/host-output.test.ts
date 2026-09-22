import assert from "node:assert/strict";
import test from "node:test";
import { HostOutput } from "../src/host-output.js";

test("host output accounts for queued frames, not only bytes already inside stdout", async () => {
  const writes: (() => void)[] = [];
  const output = new HostOutput(
    (_chunk, done) => {
      writes.push(() => done());
    },
    50,
    1000,
  );
  const first = output.write({ id: 1, result: "first" });
  await assert.rejects(output.write({ id: 2, result: "second queued frame" }), /stalled/);
  await Promise.resolve();
  writes.shift()!();
  await first;
  const afterDrain = output.write({ id: 3, result: true });
  await Promise.resolve();
  writes.shift()!();
  await afterDrain;
});

test("a blocked host write expires without retrying a frame", async () => {
  let count = 0;
  const output = new HostOutput(
    () => {
      count++;
    },
    4096,
    10,
  );
  await assert.rejects(output.write({ id: 1, result: true }), /timed out/);
  await assert.rejects(output.write({ id: 2, result: true }), /timed out/);
  assert.equal(count, 1);
});
