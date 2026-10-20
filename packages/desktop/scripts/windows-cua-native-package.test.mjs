import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV,
  resolveWindowsCuaNativePackageRoots,
} from "./windows-cua-native-package.mjs";

test("other platforms do not consume the patched Windows addon", () => {
  for (const os of ["linux", "darwin"]) {
    assert.equal(
      resolveWindowsCuaNativePackageRoots({
        targetPlatform: { os, arch: "x64" },
        env: { [WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV]: "relative/untrusted" },
      }),
      undefined,
    );
  }
});

test("Windows packaging selects the patched native package for each architecture", () => {
  for (const arch of ["x64", "arm64"]) {
    const root = resolve("fixtures", `xa11y-win32-${arch}`);
    assert.deepEqual(
      resolveWindowsCuaNativePackageRoots({
        targetPlatform: { os: "win32", arch },
        env: { [WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV]: `  ${root}  ` },
      }),
      { [`@crowecawcaw/xa11y-win32-${arch}-msvc`]: root },
    );
  }
});

test("Windows cannot silently package the unpatched npm addon", () => {
  const targetPlatform = { os: "win32", arch: "x64" };
  assert.throws(
    () => resolveWindowsCuaNativePackageRoots({ targetPlatform, env: {} }),
    /CODEZ_CUA_WINDOWS_XA11Y_NATIVE_ROOT is required/u,
  );
  assert.throws(
    () =>
      resolveWindowsCuaNativePackageRoots({
        targetPlatform,
        env: { [WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV]: "relative/untrusted" },
      }),
    /must be an absolute path/u,
  );
  assert.throws(
    () =>
      resolveWindowsCuaNativePackageRoots({
        targetPlatform: { os: "win32", arch: "ia32" },
        env: {},
      }),
    /unsupported Windows architecture/u,
  );
});
