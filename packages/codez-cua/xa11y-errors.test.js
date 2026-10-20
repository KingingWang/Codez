import assert from "node:assert/strict";
import test from "node:test";
import { isXa11yPermissionDenied, isXa11yTimeout } from "./xa11y-errors.js";

test("HRESULT timeout classification supports signed decimal without hexadecimal text", () => {
  for (const message of [
    "Platform error (-2147023436)",
    "error -2147023436: timeout",
    "0x800705B4",
    "Platform error (-2146233083): The operation has timed out. (0x80131505)",
    "error -2146233083",
    "0x80131505",
  ]) {
    assert.equal(isXa11yTimeout(new Error(message)), true, message);
    assert.equal(isXa11yPermissionDenied(new Error(message)), false, message);
  }
  assert.equal(isXa11yTimeout(new Error("value 12147023436")), false);
  assert.equal(
    isXa11yTimeout(new Error("Platform error (-2146233012): failed (0x80131501)")),
    false,
  );
  assert.equal(
    isXa11yTimeout(new Error("Platform error (-2147023435): failed (0x800705B3)")),
    false,
  );
});

test("HRESULT access denial classification supports signed decimal without confusing timeout", () => {
  for (const message of [
    "Platform error (-2147024891)",
    "error -2147024891: denied",
    "0x80070005",
  ]) {
    assert.equal(isXa11yPermissionDenied(new Error(message)), true, message);
  }
  assert.equal(isXa11yPermissionDenied(new Error("value 12147024891")), false);
});
