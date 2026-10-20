import assert from "node:assert/strict";
import test from "node:test";
import { resumeRootLegacyOAuthSession } from "./legacyOAuthRestore.js";

test("restored legacy OAuth refreshes account selection before Provider state", async () => {
  const calls: string[] = [];
  await resumeRootLegacyOAuthSession({
    hasRestoredUser: true,
    isCurrent: () => true,
    readActiveProvider: async () => {
      calls.push("read");
      return "zai";
    },
    refreshRestoredProviderFamily: async (provider) => {
      calls.push(`family:${provider}`);
    },
    refreshProviderState: async () => {
      calls.push("provider");
    },
  });
  assert.deepEqual(calls, ["read", "family:zai", "provider"]);
});

test("a Host switch during restored family refresh never starts the old Provider refresh", async () => {
  let familyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    familyStarted = resolve;
  });
  let releaseFamily!: () => void;
  const family = new Promise<void>((resolve) => {
    releaseFamily = resolve;
  });
  let current = true;
  let providerRefreshes = 0;
  const task = resumeRootLegacyOAuthSession({
    hasRestoredUser: true,
    isCurrent: () => current,
    readActiveProvider: async () => "zai",
    refreshRestoredProviderFamily: async () => {
      familyStarted();
      await family;
    },
    refreshProviderState: async () => {
      providerRefreshes++;
    },
  });
  await started;
  current = false;
  releaseFamily();
  await task;
  assert.equal(providerRefreshes, 0);
});

test("an unavailable cached legacy account still refreshes its Provider View once", async () => {
  let providerRefreshes = 0;
  await resumeRootLegacyOAuthSession({
    hasRestoredUser: false,
    isCurrent: () => true,
    readActiveProvider: async () => {
      assert.fail("No account was restored");
    },
    refreshRestoredProviderFamily: async () => {
      assert.fail("No account was restored");
    },
    refreshProviderState: async () => {
      providerRefreshes++;
    },
  });
  assert.equal(providerRefreshes, 1);
});
