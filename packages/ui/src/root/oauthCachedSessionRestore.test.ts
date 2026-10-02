import assert from "node:assert/strict";
import test from "node:test";
import { applyCachedOAuthSessionRestoreResult } from "./oauthCachedSessionRestore.js";

test("old reauthentication confirmation cannot act on a new Codex Host", async () => {
  let releasePrompt!: (confirmed: boolean) => void;
  const prompt = new Promise<boolean>((resolve) => {
    releasePrompt = resolve;
  });
  let reauthenticationCalls = 0;
  let current = true;
  const restoring = applyCachedOAuthSessionRestoreResult({
    result: { status: "reauthentication-required", reason: "jwt-expired" },
    setUser: () => {},
    requestAlert: () => prompt,
    onReauthenticationRequired: () => {
      reauthenticationCalls++;
    },
    copy: { title: "Old account" },
    isCurrent: () => current,
  });
  current = false;
  releasePrompt(true);
  assert.equal(await restoring, false);
  assert.equal(reauthenticationCalls, 0);
});
