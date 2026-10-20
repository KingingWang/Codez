// quarantine 不变量与 Gatekeeper 拦截分类的回归测试。
// 背景：带 com.apple.quarantine 的 ad-hoc 随包 Helper 会被 Gatekeeper 拒杀
// （SIGKILL / 已不能再打开），权限流过去把启动失败误读成"未授权"并反复发起
// TCC 请求，形成录屏弹窗死循环。规则见
// docs/cua-permission-broker/cua-helper-installation.md 与
// docs/cua-permission-broker/codez-cua-permission-broker.md。
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCuaHelperBootstrapExit,
  createCuaHelperInstaller,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./broker-server.js";
import { CuaHelperError } from "./broker.js";
import { HELPER_BUNDLE_ID } from "./broker-helper-constants.js";

const createTemporaryDirectory = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codez-cua-quarantine-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

function quarantineInstallerDependencies(quarantined, options = {}) {
  return {
    resolveIdentity: async (appPath) => ({
      appPath,
      executablePath: join(appPath, "helper"),
      displayName: "Computer Use",
      bundleId: HELPER_BUNDLE_ID,
      version: "1.0.0",
      buildVersion: "1",
    }),
    readExecutableArchs: async () => ["arm64"],
    verifyCodeSignature: async () => {},
    verifyTeamIdentifier: async () => "TEAM",
    verifyGatekeeper: async () => {},
    copyBundle: async (source, destination) => {
      await cp(source, destination, { recursive: true });
      // 模拟 cp 保留 xattr：隔离属性随源一起被复制进 staging/安装路径。
      if (quarantined.has(source)) quarantined.add(destination);
    },
    probeQuarantine: async (appPath) => quarantined.has(appPath),
    removeQuarantine: async (appPath) => {
      options.removals?.push(appPath);
      if (options.sticky === false) return;
      quarantined.delete(appPath);
    },
  };
}

function createQuarantineInstaller(root, sourcePath, installPath, dependencies) {
  return createCuaHelperInstaller({
    env: { CODEZ_RUNTIME_ENV: "production", NODE_ENV: "production" },
    platform: "darwin",
    arch: "arm64",
    installRoot: root,
    installPath,
    bundledAppPath: sourcePath,
    dependencies,
  });
}

test("installer strips quarantine from staging before promotion", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "Codez Computer Use.app");
  await mkdir(sourcePath, { recursive: true });
  const quarantined = new Set([sourcePath]);
  const removals = [];
  const installer = createQuarantineInstaller(
    root,
    sourcePath,
    installPath,
    quarantineInstallerDependencies(quarantined, { removals }),
  );

  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(removals.length, 1);
  assert.match(removals[0], /\.install-/u);
  assert.equal(quarantined.has(installPath), false);
});

test("installer self-heals quarantined installed helper on same-version fast path", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "Codez Computer Use.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });
  const quarantined = new Set([installPath]);
  const installer = createQuarantineInstaller(
    root,
    sourcePath,
    installPath,
    quarantineInstallerDependencies(quarantined),
  );

  assert.equal(await installer.ensureInstalled(), installPath);
  assert.equal(quarantined.has(installPath), false);
});

test("installer fails closed when quarantine removal does not stick", async (t) => {
  const root = await createTemporaryDirectory(t);
  const sourcePath = join(root, "Bundled.app");
  const installPath = join(root, "installed", "Codez Computer Use.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });
  const installer = createQuarantineInstaller(
    root,
    sourcePath,
    installPath,
    quarantineInstallerDependencies(new Set([installPath]), { sticky: false }),
  );

  await assert.rejects(
    installer.ensureInstalled(),
    (error) => error instanceof CuaHelperError && error.code === "helper_quarantine_present",
  );
});

test("bootstrap exit classification marks darwin SIGKILL as launch blocked", () => {
  assert.equal(
    classifyCuaHelperBootstrapExit({ code: null, signal: "SIGKILL", platform: "darwin" }),
    "helper_launch_blocked",
  );
  assert.equal(
    classifyCuaHelperBootstrapExit({ code: null, signal: "SIGKILL", platform: "win32" }),
    undefined,
  );
  assert.equal(
    classifyCuaHelperBootstrapExit({ code: 1, signal: null, platform: "darwin" }),
    undefined,
  );
});

test("screen recording request refuses to open a quarantined helper", async () => {
  let launched = 0;
  const result = await requestHelperScreenRecordingPermissionViaLaunchServices({
    platform: "darwin",
    helperAppPath: "/tmp/quarantined-helper.app",
    probeQuarantine: async () => true,
    launchApplication: async () => {
      launched += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "helper_quarantine_present");
  assert.equal(launched, 0);
});
