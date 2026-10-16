import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeCodezRuntimeEnv,
  isCodezCuaInternalFeatureEnabled,
  CODEZ_CUA_DEV_MODE_ENV_KEY,
  CODEZ_CUA_PRODUCT_HELPER_ENV_KEY,
} from "./runtimeEnv.js";

const LEGACY_BROKER_CAPABILITY_ENV = "CODEZ_CUA_PERMISSION_BROKER_CAPABILITY";

test("CUA internal feature is fail-closed unless an internal switch is explicitly true", () => {
  const disabledCases = [
    {},
    { [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "" },
    { [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "0" },
    { [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "false" },
    { [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "off" },
    { [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "unexpected" },
    { [CODEZ_CUA_DEV_MODE_ENV_KEY]: "false" },
    { [CODEZ_CUA_DEV_MODE_ENV_KEY]: "unexpected" },
  ];

  for (const env of disabledCases) {
    assert.equal(isCodezCuaInternalFeatureEnabled(env), false, JSON.stringify(env));
  }
});

test("CUA internal feature accepts only explicit true values", () => {
  for (const value of ["1", "true", "on", " TRUE ", " On "]) {
    assert.equal(
      isCodezCuaInternalFeatureEnabled({ [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: value }),
      true,
      value,
    );
  }

  assert.equal(
    isCodezCuaInternalFeatureEnabled({
      [CODEZ_CUA_DEV_MODE_ENV_KEY]: "on",
      [CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]: "off",
    }),
    true,
  );
});

test("legacy CUA broker capability is removed from the generic runtime environment", () => {
  assert.deepEqual(
    sanitizeCodezRuntimeEnv({
      [LEGACY_BROKER_CAPABILITY_ENV]: "stale-capability",
      CODEZ_TEST_KEEP: "kept",
    }),
    { CODEZ_TEST_KEEP: "kept" },
  );
});
