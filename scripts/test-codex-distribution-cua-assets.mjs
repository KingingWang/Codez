import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const builderSource = await readFile(
  new URL("../packages/desktop/electron-builder.config.js", import.meta.url),
  "utf8",
);

function createAssetAssertion(name, { isCodexBuild, targetPlatform, sharpRequired = true }) {
  const source = builderSource.match(
    new RegExp(`function ${name}\\(context\\) \\{[\\s\\S]*?^\\}`, "m"),
  );
  assert.ok(source, `missing packaging assertion: ${name}`);
  const checks = [];
  const verify = (kind) => (options) => {
    checks.push({ kind, ...options });
    return ["missing legacy native asset"];
  };
  const assertion = runInNewContext(`(${source[0]})`, {
    isCodexBuild,
    targetPlatform,
    desktopPackageRoot: "/fixture/desktop",
    resolvePackagedResourcesDir: () => "/fixture/resources",
    isSharpRequiredByComputerUse: () => sharpRequired,
    verifyStagedSharp: verify("sharp"),
    verifyStagedKoffi: verify("koffi"),
  });
  return { assertion, checks };
}

// 回归依据：Codex 包没有 resources/glm。执行真实断言函数，确保不读取 legacy
// 资产，同时确认显式 legacy 构建仍会因缺失原生库失败，不能全局关闭校验。
for (const os of ["darwin", "linux", "win32"]) {
  for (const arch of ["x64", "arm64"]) {
    const targetPlatform = { os, arch, key: `${os}-${arch}` };
    for (const [name, kind, expectedChecks] of [
      ["assertPackagedCuaSharp", "sharp", 2],
      ["assertPackagedCuaKoffi", "koffi", 1],
    ]) {
      test(`${targetPlatform.key} Codex skips legacy ${kind}, while legacy fails closed`, () => {
        const codex = createAssetAssertion(name, { isCodexBuild: true, targetPlatform });
        assert.doesNotThrow(() => codex.assertion({}));
        assert.deepEqual(codex.checks, []);

        const legacy = createAssetAssertion(name, { isCodexBuild: false, targetPlatform });
        assert.throws(() => legacy.assertion({}), /missing legacy native asset/);
        assert.equal(legacy.checks.length, expectedChecks);
        for (const check of legacy.checks) {
          assert.equal(check.kind, kind);
          assert.equal(check.resourcesDir, "/fixture/resources");
          assert.equal(check.targetPlatform, targetPlatform);
        }
        if (kind === "sharp") {
          assert.deepEqual(
            legacy.checks.map((check) => check.pluginRelativePath),
            ["packages/browser-use-plugin", "packages/codez-cua-plugin"],
          );
        }
      });
    }
  }
}

test("legacy without a real computer-use producer still skips Sharp validation", () => {
  const { assertion, checks } = createAssetAssertion("assertPackagedCuaSharp", {
    isCodexBuild: false,
    targetPlatform: { os: "linux", arch: "x64", key: "linux-x64" },
    sharpRequired: false,
  });
  assert.doesNotThrow(() => assertion({}));
  assert.deepEqual(checks, []);
});
