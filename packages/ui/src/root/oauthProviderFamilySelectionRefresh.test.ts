import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "@codez/services";
import { resolveProviderFamilyDomainFromOAuthProvider } from "@codez/shared";
import {
  refreshLatestModelProviderFamilySelectionAfterLogin,
  refreshRestoredOAuthProviderFamilyAfterStartup,
} from "./oauthProviderFamilySelectionRefresh.js";

test("restored legacy OAuth cannot refresh Provider after settings resolves on a new Codex Host", async () => {
  const domain = resolveProviderFamilyDomainFromOAuthProvider("zai");
  assert.ok(domain);
  let releaseSettings!: (value: unknown) => void;
  const settings = new Promise<unknown>((resolve) => {
    releaseSettings = resolve;
  });
  let providerRefreshes = 0;
  const services = {
    settingService: { get: () => settings },
    providerSettingsService: {
      async refresh() {
        providerRefreshes++;
        return { revision: 1, providers: [] };
      },
    },
  } as unknown as IServiceAccessor;
  let current = true;
  const restored = refreshRestoredOAuthProviderFamilyAfterStartup({
    activeProvider: "zai",
    services,
    isCurrent: () => current,
  });
  current = false;
  releaseSettings({
    providerFamilyDomain: domain,
    providerFamilyConnectionSelections: { [domain]: { kind: "start-plan" } },
  });
  assert.equal(await restored, null);
  assert.equal(providerRefreshes, 0);
});

test("unselected legacy OAuth cannot start a Provider read after initial settings resolves stale", async () => {
  let releaseSettings!: (value: unknown) => void;
  const settings = new Promise<unknown>((resolve) => {
    releaseSettings = resolve;
  });
  let providerRefreshes = 0;
  let selectionWrites = 0;
  const services = {
    settingService: {
      get: () => settings,
      async update() {
        selectionWrites++;
      },
    },
    providerSettingsService: {
      async refresh() {
        providerRefreshes++;
        return { revision: 1, providers: [] };
      },
    },
    usageStatsService: {
      async getEntitlementSnapshot() {
        return null;
      },
    },
    codingPlanSubscriptionService: {
      async getEnterprisePricing() {
        return { productList: [] };
      },
    },
  } as unknown as IServiceAccessor;
  let current = true;
  const selection = refreshLatestModelProviderFamilySelectionAfterLogin({
    provider: "zai",
    services,
    isCurrent: () => current,
  });
  current = false;
  releaseSettings({ providerFamilyConnectionSelections: {} });
  assert.equal(await selection, null);
  assert.equal(providerRefreshes, 0);
  assert.equal(selectionWrites, 0);
});

test("restored legacy selection still refreshes the saved account while its Host is current", async () => {
  const domain = resolveProviderFamilyDomainFromOAuthProvider("zai");
  assert.ok(domain);
  const saved = { kind: "start-plan" };
  let providerRefreshes = 0;
  const services = {
    settingService: {
      async get() {
        return {
          providerFamilyDomain: domain,
          providerFamilyConnectionSelections: { [domain]: saved },
        };
      },
    },
    providerSettingsService: {
      async refresh() {
        providerRefreshes++;
        return { revision: 1, providers: [] };
      },
    },
  } as unknown as IServiceAccessor;
  assert.deepEqual(
    await refreshRestoredOAuthProviderFamilyAfterStartup({
      activeProvider: "zai",
      services,
      isCurrent: () => true,
    }),
    saved,
  );
  assert.equal(providerRefreshes, 1);
});

test("old Host entitlements cannot conditionally write a new legacy selection after switching Codex", async () => {
  let entitlementStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    entitlementStarted = resolve;
  });
  let releaseEntitlement!: () => void;
  const entitlement = new Promise<null>((resolve) => {
    releaseEntitlement = () => resolve(null);
  });
  let selectionWrites = 0;
  let current = true;
  const services = {
    settingService: {
      async get() {
        return { providerFamilyConnectionSelections: {} };
      },
      async update() {
        selectionWrites++;
      },
    },
    providerSettingsService: {
      async refresh() {
        return { revision: 1, providers: [] };
      },
    },
    usageStatsService: {
      getEntitlementSnapshot() {
        entitlementStarted();
        return entitlement;
      },
    },
    codingPlanSubscriptionService: {
      async getEnterprisePricing() {
        return { productList: [] };
      },
    },
  } as unknown as IServiceAccessor;
  const selection = refreshLatestModelProviderFamilySelectionAfterLogin({
    provider: "zai",
    services,
    isCurrent: () => current,
  });
  await started;
  current = false;
  releaseEntitlement();
  assert.equal(await selection, null);
  assert.equal(selectionWrites, 0);
});
