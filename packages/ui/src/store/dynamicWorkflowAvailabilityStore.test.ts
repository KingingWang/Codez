import assert from "node:assert/strict";
import test from "node:test";
import type { ICodingPlanSubscriptionService } from "@codez/services";
import { useDynamicWorkflowAvailabilityStore } from "./dynamicWorkflowAvailabilityStore.js";

test("Codex takeover disables an old workflow result and a later legacy Host can reload", async () => {
  let releaseOld!: (value: { mode: "alwaysOn"; enabled: true; source: "remote" }) => void;
  const oldResponse = new Promise<{ mode: "alwaysOn"; enabled: true; source: "remote" }>(
    (resolve) => {
      releaseOld = resolve;
    },
  );
  let reads = 0;
  const oldService = {
    getDynamicWorkflowClientConfig: () => {
      reads++;
      return oldResponse;
    },
  } as unknown as ICodingPlanSubscriptionService;
  const state = useDynamicWorkflowAvailabilityStore;
  const pending = state.getState().ensureLoaded(oldService);
  state.getState().disableForUnsupportedRuntime();
  releaseOld({ mode: "alwaysOn", enabled: true, source: "remote" });
  await pending;
  assert.equal(state.getState().enabled, false);
  assert.equal(state.getState().config, null);
  assert.equal(reads, 1);

  const newService = {
    getDynamicWorkflowClientConfig: async () => {
      reads++;
      return { mode: "alwaysOn", enabled: true, source: "remote" };
    },
  } as unknown as ICodingPlanSubscriptionService;
  await state.getState().ensureLoaded(newService);
  assert.equal(state.getState().enabled, true);
  assert.equal(reads, 2);
  state.getState().disableForUnsupportedRuntime();
});

test("a new legacy Host does not wait for or accept a previous Host's workflow response", async () => {
  let releaseOld!: (value: { mode: "alwaysOn"; enabled: true; source: "remote" }) => void;
  const oldResponse = new Promise<{ mode: "alwaysOn"; enabled: true; source: "remote" }>(
    (resolve) => {
      releaseOld = resolve;
    },
  );
  const oldService = {
    getDynamicWorkflowClientConfig: () => oldResponse,
  } as unknown as ICodingPlanSubscriptionService;
  const newService = {
    getDynamicWorkflowClientConfig: async () => ({
      mode: "disabled",
      enabled: false,
      source: "remote",
    }),
  } as unknown as ICodingPlanSubscriptionService;
  const state = useDynamicWorkflowAvailabilityStore;
  const oldRead = state.getState().ensureLoaded(oldService);
  await state.getState().ensureLoaded(newService);
  assert.equal(state.getState().enabled, false);
  releaseOld({ mode: "alwaysOn", enabled: true, source: "remote" });
  await oldRead;
  assert.equal(state.getState().enabled, false);
  state.getState().disableForUnsupportedRuntime();
});

test("reload uses the current Host contract and cannot re-enable workflow after Codex takeover", async () => {
  let releaseReload!: (value: { mode: "alwaysOn"; enabled: true; source: "remote" }) => void;
  const pendingConfig = new Promise<{ mode: "alwaysOn"; enabled: true; source: "remote" }>(
    (resolve) => {
      releaseReload = resolve;
    },
  );
  const options: unknown[] = [];
  const service = {
    getDynamicWorkflowClientConfig: (option: unknown) => {
      options.push(option);
      return options.length === 1
        ? Promise.resolve({ mode: "disabled", enabled: false, source: "remote" })
        : pendingConfig;
    },
  } as unknown as ICodingPlanSubscriptionService;
  const state = useDynamicWorkflowAvailabilityStore;
  await state.getState().ensureLoaded(service);
  const reload = state.getState().reload(service);
  assert.deepEqual(options, [{}, {}]);
  state.getState().disableForUnsupportedRuntime();
  releaseReload({ mode: "alwaysOn", enabled: true, source: "remote" });
  await reload;
  assert.equal(state.getState().enabled, false);
  assert.equal(state.getState().config, null);
});
