import assert from "node:assert/strict";
import test from "node:test";
import { deferred, setup, turn } from "./fixtures/commands-fixture.js";

test(
  "maintenance drains existing admissions and holds later commands until preflight/delete completes",
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t);
    const firstStarted = deferred();
    const firstRelease = deferred();
    const maintenanceStarted = deferred();
    const maintenanceRelease = deferred();
    const order: string[] = [];
    h.rpc.handlers.set("turn/start", async (params) => {
      const first = params.clientUserMessageId === "first";
      order.push(first ? "first" : "later");
      if (first) {
        firstStarted.resolve();
        await firstRelease.promise;
      }
      return { turn: turn(first ? "first-turn" : "later-turn") };
    });
    const first = h.execute({
      ...h.command("sendText", { text: "first", requestedDelivery: "startNow" }),
      commandId: "first",
    });
    await firstStarted.promise;
    const maintenance = h.router.exclusiveMaintenance(async () => {
      order.push("maintenance");
      maintenanceStarted.resolve();
      await maintenanceRelease.promise;
    });
    const later = h.execute({
      ...h.command("sendText", { text: "later", requestedDelivery: "startNow" }),
      commandId: "later",
    });
    assert.deepEqual(order, ["first"]);
    firstRelease.resolve();
    assert.equal((await first).status, "accepted");
    await maintenanceStarted.promise;
    assert.deepEqual(order, ["first", "maintenance"]);
    maintenanceRelease.resolve();
    await maintenance;
    assert.equal((await later).status, "accepted");
    assert.deepEqual(order, ["first", "maintenance", "later"]);
  },
);

test(
  "failed maintenance releases admission without swallowing its error or retrying native commands",
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t);
    const entered = deferred();
    const release = deferred();
    const maintenance = h.router.exclusiveMaintenance(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("preflight failed");
    });
    const rejected = assert.rejects(maintenance, /preflight failed/);
    await entered.promise;
    const later = h.execute(h.command("sendText", { text: "later" }));
    assert.equal(h.rpc.methods().includes("turn/start"), false);
    release.resolve();
    await rejected;
    assert.equal((await later).status, "accepted");
    assert.deepEqual(h.rpc.methods(), ["turn/start"]);
  },
);

test(
  "consecutive maintenance barriers and intervening admissions keep receipt order without deadlock",
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t);
    const release = deferred();
    const entered = deferred();
    const order: string[] = [];
    const first = h.router.exclusiveMaintenance(async () => {
      order.push("first");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const command = h.execute(h.command("sendText", { text: "fixture" }));
    const second = h.router.exclusiveMaintenance(async () => {
      order.push("second");
      assert.equal(h.rpc.methods().includes("turn/start"), true);
    });
    release.resolve();
    await first;
    assert.equal((await command).status, "accepted");
    await second;
    assert.deepEqual(order, ["first", "second"]);
  },
);
