import assert from "node:assert/strict";
import test from "node:test";
import { zcodeSessionCloseResultSchema } from "@zcode/shared";
import { handleLegacySession } from "../src/legacy-sessions.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";

test("legacy session close matches the strict desktop response contract", async () => {
  const calls: string[] = [];
  const rpc = {
    async request(method: string) {
      calls.push(method);
      return {};
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, "/workspace");
  store.markStarted({ id: "thread", cwd: "/workspace", turns: [] });
  const result = await handleLegacySession(
    "session/close",
    { sessionId: "thread" },
    rpc,
    store,
    "/workspace",
  );
  assert.deepEqual(zcodeSessionCloseResultSchema.parse(result), { closed: true });
  assert.deepEqual(calls, ["thread/unsubscribe"]);
});
