import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLedger } from "../src/command-ledger.js";

test("lost acknowledgements stay unknown across restarts and cannot be dispatched twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ledger-"));
  try {
    const ledger = new CommandLedger(root);
    assert.equal(await ledger.begin(null, "create"), true);
    const restarted = new CommandLedger(root);
    assert.equal(await restarted.begin(null, "create"), false);
    assert.equal(await restarted.lookup(null, "create"), "unknown");
    const ack = { commandId: "create", status: "accepted" as const, revisionAtDecision: 1 };
    await ledger.finish(null, ack);
    assert.deepEqual(await restarted.lookup(null, "create"), ack);
    assert.equal(await restarted.lookup("different", "create"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
