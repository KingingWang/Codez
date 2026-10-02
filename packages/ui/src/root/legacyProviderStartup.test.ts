import assert from "node:assert/strict";
import test from "node:test";
import { startRootLegacyProviderStartup } from "./legacyProviderStartup.js";

test("legacy startup runs migration, settings refresh and Provider refresh in order", async () => {
  const events: string[] = [];
  await startRootLegacyProviderStartup({
    migrate: async () => {
      events.push("migrate");
    },
    isCurrent: () => true,
    markMigrationComplete: () => events.push("complete"),
    refreshAppSettings: async () => {
      events.push("settings");
    },
    refreshProviderState: async () => {
      events.push("provider");
    },
  });
  assert.deepEqual(events, ["migrate", "complete", "settings", "provider"]);
});

test("switching Host during settings refresh cannot admit a stale Provider refresh", async () => {
  const events: string[] = [];
  let settingsStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    settingsStarted = resolve;
  });
  let finishSettings!: () => void;
  const settings = new Promise<void>((resolve) => {
    finishSettings = resolve;
  });
  let current = true;
  const task = startRootLegacyProviderStartup({
    migrate: async () => {},
    isCurrent: () => current,
    markMigrationComplete: () => events.push("complete"),
    refreshAppSettings: async () => {
      settingsStarted();
      await settings;
    },
    refreshProviderState: async () => {
      events.push("provider");
    },
  });
  await started;
  current = false;
  finishSettings();
  await task;
  assert.deepEqual(events, ["complete"]);
});

test("switching Host during migration skips both refresh calls", async () => {
  let finishMigration!: () => void;
  const migration = new Promise<void>((resolve) => {
    finishMigration = resolve;
  });
  const events: string[] = [];
  let current = true;
  const task = startRootLegacyProviderStartup({
    migrate: () => migration,
    isCurrent: () => current,
    markMigrationComplete: () => events.push("complete"),
    refreshAppSettings: async () => {
      events.push("settings");
    },
    refreshProviderState: async () => {
      events.push("provider");
    },
  });
  current = false;
  finishMigration();
  await task;
  assert.deepEqual(events, []);
});
