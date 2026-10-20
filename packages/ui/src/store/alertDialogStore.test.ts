import assert from "node:assert/strict";
import test from "node:test";
import { useAlertDialogStore } from "./alertDialogStore.js";

test("cancelling a legacy prompt never dismisses a later unrelated prompt", async () => {
  const store = useAlertDialogStore;
  const oldOwner = new AbortController();
  const oldResult = store.getState().requestAlert({ title: "Old account" }, oldOwner.signal);
  assert.equal(store.getState().pendingRequest?.title, "Old account");
  oldOwner.abort();
  assert.equal(store.getState().pendingRequest, undefined);
  assert.equal(await oldResult, false);

  const nextResult = store.getState().requestAlert({ title: "Current confirmation" });
  oldOwner.abort();
  assert.equal(store.getState().pendingRequest?.title, "Current confirmation");
  store.getState().settleAlert(true);
  assert.equal(await nextResult, true);
});
