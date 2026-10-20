import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  resolveCuaPermissionUnavailableErrorKind,
} from "../src/cua-permission-broker/cuaHelperInstaller.js";

test("bundled production Helper skips signing gates during install, reuse and pre-launch checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-unsigned-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledAppPath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "Codez Computer Use.app");
  await mkdir(bundledAppPath);
  await writeFile(join(bundledAppPath, "build.txt"), "1");
  const verifiedPaths: string[] = [];
  let invalidInstalledArchitecture = false;
  const installer = createCanonicalCuaHelperInstaller({
    env: { NODE_ENV: "production", CODEZ_RUNTIME_ENV: "production" },
    platform: "darwin",
    arch: "arm64",
    bundledAppPath,
    installRoot: root,
    installPath,
    dependencies: {
      resolveIdentity: async (appPath) => {
        verifiedPaths.push(appPath);
        return {
          appPath,
          executablePath: join(appPath, "helper"),
          displayName: "Codez Computer Use",
          bundleId: "dev.codez.cua-helper",
          buildVersion: (await readFile(join(appPath, "build.txt"), "utf8")).trim(),
        };
      },
      readExecutableArchs: async (executablePath) =>
        invalidInstalledArchitecture &&
        executablePath === join(installPath, "helper") &&
        (await readFile(join(installPath, "build.txt"), "utf8")).trim() === "3"
          ? ["x86_64"]
          : ["aarch64"],
      verifyCodeSignature: async () => assert.fail("unsigned bundle must not invoke codesign"),
      verifyTeamIdentifier: async () => assert.fail("unsigned bundle must not require a Team ID"),
      verifyGatekeeper: async () => assert.fail("unsigned bundle must not invoke Gatekeeper"),
      copyBundle: (source, destination) => cp(source, destination, { recursive: true }),
    },
  });

  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(await installer.ensureInstalled(), installPath);
  await installer.verifyInstalled(installPath);
  assert.ok(verifiedPaths.includes(bundledAppPath));
  assert.ok(verifiedPaths.includes(installPath));
  assert.ok(verifiedPaths.some((path) => path.includes(".install-")));
  assert.equal(await readFile(join(installPath, "build.txt"), "utf8"), "1");

  await writeFile(join(bundledAppPath, "build.txt"), "2");
  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(await readFile(join(installPath, "build.txt"), "utf8"), "2");

  await writeFile(join(bundledAppPath, "build.txt"), "3");
  invalidInstalledArchitecture = true;
  await assert.rejects(installer.ensureInstalled(), /installation failed/u);
  assert.equal(await readFile(join(installPath, "build.txt"), "utf8"), "2");
});

test("signature policy changes only for a bundled source and preserves architecture normalization", async () => {
  const readExecutableArchs = async () => ["x86_64", "amd64", "aarch64"];
  const standalone = canonicalizeCuaHelperInstallerOptions({
    dependencies: { readExecutableArchs },
  });
  assert.notEqual(standalone.verifySignature, false);
  const bundled = canonicalizeCuaHelperInstallerOptions({
    bundledAppPath: "/Applications/Codez.app/Contents/Resources/cua-helper/Codez Computer Use.app",
    dependencies: { readExecutableArchs },
  });
  assert.equal(bundled.verifySignature, false);
  assert.deepEqual(await bundled.dependencies!.readExecutableArchs!("helper"), ["x64", "arm64"]);
});

// errorKind 契约（docs/cua-permission-broker/codez-cua-permission-broker.md）：
// 只映射两种 Helper 被 macOS 拦截的 kind；其余失败保持 undefined，
// UI 沿用现有"未知"展示与重试语义。
test("resolveCuaPermissionUnavailableErrorKind only maps contracted kinds", () => {
  assert.equal(
    resolveCuaPermissionUnavailableErrorKind({ code: "helper_launch_blocked" }),
    "helper_launch_blocked",
  );
  assert.equal(
    resolveCuaPermissionUnavailableErrorKind({ code: "helper_quarantine_present" }),
    "helper_quarantine_present",
  );
  assert.equal(resolveCuaPermissionUnavailableErrorKind(new Error("boom")), undefined);
  assert.equal(resolveCuaPermissionUnavailableErrorKind({ code: "helper_unavailable" }), undefined);
  assert.equal(resolveCuaPermissionUnavailableErrorKind(undefined), undefined);
});
