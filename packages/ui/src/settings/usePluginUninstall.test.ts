import assert from "node:assert/strict";
import test from "node:test";
import type { IPluginManagementService } from "@codez/services";
import { confirmPluginUninstall } from "./usePluginUninstall.js";

const pluginService = {} as IPluginManagementService;

test("failed uninstall keeps confirmation pending and skips capability refresh", async () => {
  let refreshed = false;
  let cleared = false;
  const completed = await confirmPluginUninstall({
    pendingId: "fixture-plugin",
    pluginService,
    uninstallPlugin: async () => false,
    clearPending: () => {
      cleared = true;
    },
    onAfterUninstall: async () => {
      refreshed = true;
    },
  });

  assert.equal(completed, false);
  assert.equal(refreshed, false);
  assert.equal(cleared, false);
});

test("successful uninstall refreshes capabilities before clearing confirmation", async () => {
  const events: string[] = [];
  const completed = await confirmPluginUninstall({
    pendingId: "fixture-plugin",
    pluginService,
    uninstallPlugin: async () => true,
    clearPending: () => {
      events.push("clear");
    },
    onAfterUninstall: async () => {
      events.push("refresh");
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(events, ["refresh", "clear"]);
});
