#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

assert.deepEqual(process.argv.slice(2), ["app-server", "--listen", "stdio://"]);
assert.equal(process.env.HOME, process.env.CODEX_HOME);
const mode = process.env.FAKE_CODEX_MODE;
let initialized = false;
let initializeCount = 0;
let mutationCount = 0;
let delayedMutationId;
const replies = [];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const trace = (text) => appendFile(process.env.FAKE_CODEX_TRACE, `${text}\n`);
const input = createInterface({ input: process.stdin });

if (mode === "stubborn") process.on("SIGTERM", () => void trace("SIGTERM"));
input.on("close", async () => {
  await trace("EOF");
  if (mode === "stubborn") setInterval(() => {}, 1000);
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    replies.push(message);
    send({ method: "reply/received", params: message });
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    initializeCount++;
    assert.equal(initializeCount, 1);
    assert.equal(params.capabilities.experimentalApi, true);
    assert.equal(typeof params.clientInfo.name, "string");
    assert.equal(typeof params.clientInfo.version, "string");
    if (mode === "handshake-timeout") return;
    if (mode === "handshake-error") {
      send({ id, error: { code: -32000, message: "initialization denied" } });
      return;
    }
    setTimeout(() => send({ id, result: { userAgent: "fake" } }), 20);
    return;
  }
  if (method === "initialized") {
    assert.equal(initializeCount, 1);
    initialized = true;
    return;
  }
  assert.equal(initialized, true);
  switch (method) {
    case "echo":
      setTimeout(() => send({ id, result: params }), params?.delay ?? 0);
      break;
    case "status":
      send({ id, result: { initializeCount, mutationCount, replies, pid: process.pid } });
      break;
    case "mutate":
      mutationCount++;
      delayedMutationId = id;
      break;
    case "release-mutation":
      send({ id: delayedMutationId, result: "late mutation result" });
      delayedMutationId = undefined;
      send({ id, result: null });
      break;
    case "hang":
      break;
    case "error":
      send({ id, error: { code: -32602, message: "invalid params", data: { field: "x" } } });
      break;
    case "events":
      send({ method: "item/delta", params: { text: "hello" } });
      send({ id: "approval-1", method: "item/approval", params: { turnId: "t1" } });
      send({ id: 42, method: "item/question", params: {} });
      send({ id, result: null });
      break;
    case "resolve-approval":
      send({
        method: "serverRequest/resolved",
        params: { threadId: "thread", requestId: "approval-1" },
      });
      send({ id, result: null });
      break;
    case "duplicate-server-id":
      send({ id: "same", method: "item/approval" });
      send({ id: "same", method: "item/approval" });
      break;
    case "unknown-id":
      send({ id: "never-issued", result: null });
      send({ id, result: "ok" });
      send({ id, result: "duplicate" });
      break;
    case "utf8": {
      const frame = Buffer.from(`${JSON.stringify({ id, result: "你好🙂 café" })}\r\n`);
      const split = frame.indexOf(Buffer.from("🙂")) + 2;
      process.stdout.write(frame.subarray(0, split));
      setTimeout(() => process.stdout.write(frame.subarray(split)), 10);
      break;
    }
    case "raw":
      process.stderr.write("SECRET_STDERR\n");
      process.stdout.write(params.text);
      break;
    case "oversized":
      process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120));
      break;
    case "truncated":
      process.stdout.write('{"id":');
      process.stdout.end();
      break;
    case "invalid-utf8":
      process.stdout.write(Buffer.from([0x22, 0xc3, 0x28, 0x22, 0x0a]));
      break;
    case "die":
      process.stderr.write("SECRET_STDERR\n", () => process.exit(7));
      break;
    case "close-stdin":
      process.stdin.destroy();
      send({ id, result: null });
      break;
    default:
      send({ id, error: { code: -32601, message: "unknown method" } });
  }
});
