import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "@codez/services";
import { logger } from "@/logger.js";
import { ensureProviderFamilyDomainMigration } from "./providerFamilyDomainMigration.js";

test("current legacy Host still writes the inferred provider family once", async () => {
  const patches: unknown[] = [];
  const services = {
    settingService: {
      async get() {
        return {};
      },
      async update(patch: unknown) {
        patches.push(patch);
      },
    },
    oauthService: {
      async getActiveProvider() {
        return "zai";
      },
    },
  } as unknown as IServiceAccessor;
  await ensureProviderFamilyDomainMigration(services, () => true);
  assert.equal(patches.length, 1);
  assert.deepEqual(
    {
      providerFamilyDomain: (patches[0] as { providerFamilyDomain?: string }).providerFamilyDomain,
      providerFamilyDomainMigrated: (patches[0] as { providerFamilyDomainMigrated?: boolean })
        .providerFamilyDomainMigrated,
    },
    { providerFamilyDomain: "zai", providerFamilyDomainMigrated: true },
  );
});

test("switching to Codex during old settings read does not start OAuth or write migration", async () => {
  let releaseSettings!: (settings: unknown) => void;
  const settings = new Promise<unknown>((resolve) => {
    releaseSettings = resolve;
  });
  let oauthReads = 0;
  let writes = 0;
  const services = {
    settingService: {
      get: () => settings,
      async update() {
        writes++;
      },
    },
    oauthService: {
      async getActiveProvider() {
        oauthReads++;
        return "zai";
      },
    },
  } as unknown as IServiceAccessor;
  let current = true;
  const migration = ensureProviderFamilyDomainMigration(services, () => current);
  current = false;
  releaseSettings({});
  await migration;
  assert.equal(oauthReads, 0);
  assert.equal(writes, 0);
});

test("switching Host during OAuth or model read never starts a migration write", async () => {
  for (const pending of ["oauth", "models"] as const) {
    let release!: (value: unknown) => void;
    const held = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    let modelReads = 0;
    let current = true;
    const services = {
      settingService: {
        async get() {
          return {};
        },
        async update() {
          writes++;
        },
      },
      oauthService: {
        getActiveProvider: () => (pending === "oauth" ? held : Promise.resolve(null)),
      },
      modelSelectionService: {
        getView: () => {
          modelReads++;
          return pending === "models" ? held : Promise.resolve({ providers: [] });
        },
      },
    } as unknown as IServiceAccessor;
    const migration = ensureProviderFamilyDomainMigration(services, () => current);
    // 等待前一段异步调用启动；允许它完成，但不允许下一段旧 Host IO。
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    release(pending === "oauth" ? "zai" : { providers: [{ providerId: "zai" }] });
    await migration;
    assert.equal(writes, 0);
    if (pending === "oauth") assert.equal(modelReads, 0);
  }
});

test("a completed old-Host write does not report a new Codex Host as migrated", async (t) => {
  const completed = t.mock.method(logger, "info");
  let releaseWrite!: () => void;
  const writePending = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let notifyWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    notifyWriteStarted = resolve;
  });
  const services = {
    settingService: {
      async get() {
        return {};
      },
      update: () => {
        notifyWriteStarted();
        return writePending;
      },
    },
    oauthService: {
      async getActiveProvider() {
        return "zai";
      },
    },
  } as unknown as IServiceAccessor;
  let current = true;
  const migration = ensureProviderFamilyDomainMigration(services, () => current);
  await writeStarted;
  current = false;
  releaseWrite();
  await migration;
  assert.equal(completed.mock.callCount(), 0);
});
