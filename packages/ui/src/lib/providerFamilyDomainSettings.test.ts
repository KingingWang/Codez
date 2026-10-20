import assert from "node:assert/strict";
import test from "node:test";
import { setProviderFamilyDomain } from "./providerFamilyDomainSettings.js";

test("late interactive legacy settings read cannot write after native Host takeover", async () => {
  let releaseRead!: (settings: unknown) => void;
  const pendingRead = new Promise<unknown>((resolve) => {
    releaseRead = resolve;
  });
  let writes = 0;
  const service = {
    get: () => pendingRead,
    async update() {
      writes++;
    },
  } as unknown as Parameters<typeof setProviderFamilyDomain>[0];
  let current = true;
  const update = setProviderFamilyDomain(service, "zai", () => current);
  current = false;
  releaseRead({});
  await update;
  assert.equal(writes, 0);
});
