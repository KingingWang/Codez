import assert from "node:assert/strict";
import test from "node:test";
import type { IProviderSettingsService, ProviderSettingsView } from "@codez/services";
import {
  connectProviderSettingsSnapshot,
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
} from "./providerSettingsSnapshot.js";

test("a detached legacy Host cannot publish its late Provider View to Codex", async () => {
  let resolveOld!: (view: ProviderSettingsView) => void;
  const oldRead = new Promise<ProviderSettingsView>((resolve) => {
    resolveOld = resolve;
  });
  const oldService = {
    onDidChange: () => ({ dispose() {} }),
    getView: () => oldRead,
  } as unknown as IProviderSettingsService;
  const oldConnection = connectProviderSettingsSnapshot(oldService);
  oldConnection.dispose();
  resolveOld({ revision: 1, providers: [] } as unknown as ProviderSettingsView);
  await oldConnection.ready;
  assert.deepEqual(getProviderSettingsSnapshot(), { status: "loading" });
  await assert.rejects(reloadProviderSettingsSnapshot(), /尚未连接/);

  const newView = { revision: 2, providers: [] } as unknown as ProviderSettingsView;
  const newService = {
    onDidChange: () => ({ dispose() {} }),
    getView: async () => newView,
  } as unknown as IProviderSettingsService;
  const newConnection = connectProviderSettingsSnapshot(newService);
  await newConnection.ready;
  assert.deepEqual(getProviderSettingsSnapshot(), { status: "ready", view: newView });
  oldConnection.dispose();
  assert.deepEqual(getProviderSettingsSnapshot(), { status: "ready", view: newView });
  newConnection.dispose();
  assert.deepEqual(getProviderSettingsSnapshot(), { status: "loading" });
});
