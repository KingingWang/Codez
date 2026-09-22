import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { codexWorkspaceRoot } from "./codex-runtime.mjs";

test("workflow gates six native targets, four bundled remote targets and isolated bridge smoke", async () => {
  const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
  const workflow = require("yaml").parse(
    await readFile(new URL("../.github/workflows/codex-desktop.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.on.push.branches, ["feat/codex-desktop-adapter", "main"]);
  assert.equal(workflow.permissions.contents, "read");
  for (const name of ["build", "remote-assets"]) {
    const job = workflow.jobs[name];
    assert.equal(job.permissions.contents, "read");
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith("actions/setup-node")).with["node-version"],
      "24.14.0",
    );
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith("pnpm/action-setup")).with.version,
      "10.33.2",
    );
    assert.ok(job.steps.find((step) => step.run === "pnpm install --frozen-lockfile"));
  }
  const { build, release } = workflow.jobs;
  for (const command of [
    "pnpm exec tsx --test packages/services/test/codex*.test.ts packages/desktop/test/codex*.test.ts packages/server/test/codex*.test.ts",
    "pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/src/settings/codex/*.test.ts packages/ui/src/settings/codex/*.test.tsx",
  ]) {
    assert.equal(
      workflow.jobs["remote-assets"].steps.filter((step) => step.run === command).length,
      1,
    );
    assert.equal(
      build.steps.some((step) => step.run === command),
      false,
    );
  }
  assert.equal(
    new Set(build.strategy.matrix.include.map(({ os, arch }) => `${os}-${arch}`)).size,
    6,
  );
  assert.equal(build.strategy["fail-fast"], false);
  assert.equal(build.needs, "remote-assets");
  const nativeSmoke = build.steps.findIndex(
    (step) => step.run === "node scripts/codex-runtime-smoke.mjs",
  );
  assert.ok(
    build.steps.findIndex((step) => step.run?.includes("test-codex-distribution")) < nativeSmoke,
  );
  assert.equal(build.steps[nativeSmoke + 1].run, "node --test scripts/test-codex-bridge-smoke.mjs");
  assert.equal(release.needs, "build");
  assert.match(release.if, /refs\/tags\/zcode-codex-v/);
});

async function loadRuntimeModule(t, source, flavor = "codex", plugins = []) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-identity-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "test.cjs");
  await build({
    entryPoints: [resolve(codexWorkspaceRoot, source)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins,
    define: {
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(flavor),
      __ZCODE_ENV__: '"production"',
      "process.env.ZCODE_DESKTOP_RUNTIME": JSON.stringify(flavor === "codex" ? "codex" : ""),
    },
  });
  return { module: createRequire(import.meta.url)(outfile), directory };
}

test("compiled codex flavor survives normalization and preserves upstream defaults", async (t) => {
  const { module } = await loadRuntimeModule(t, "packages/shared/src/env.ts");
  assert.equal(module.ZCODE_PRODUCT_FLAVOR, "codex");
  for (const backend of ["production", "test"])
    assert.equal(module.normalizeZCodeProductFlavor("codex", backend), "codex");
  assert.equal(module.normalizeZCodeProductFlavor(undefined, "production"), "production");
  assert.equal(module.normalizeZCodeProductFlavor(undefined, "test"), "preview");
  assert.equal(module.normalizeZCodeProductFlavor("codex-other", "production"), "production");
});

test("runtime identities, settings and data roots are disjoint and idempotent", async (t) => {
  const { module: runtime, directory } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopProductRuntime.ts",
  );
  assert.equal(runtime.resolveDesktopApplicationName("codex", true), "ZCode Codex");
  assert.equal(runtime.resolveDesktopApplicationName("codex", false), "ZCode Codex Dev");
  const base = join(directory, ".zcode-codex");
  assert.equal(runtime.resolveDesktopDataBaseDir(undefined, directory), base);
  assert.equal(runtime.resolveDesktopDataBaseDir(base, directory), base);
  assert.equal(
    runtime.resolveDesktopBootstrapSettingsFile(directory),
    join(base, ".zcode/v2/setting.json"),
  );
  assert.notEqual(
    runtime.resolveDesktopBootstrapSettingsFile(directory),
    runtime.resolveDesktopBootstrapSettingsFile(directory, "production"),
  );
  assert.deepEqual(runtime.resolveDesktopUpdatePolicy(), {
    automatic: false,
    manualReleasePage: "https://github.com/KingingWang/ZCode/releases",
  });
  assert.equal(runtime.resolveDesktopUpdatePolicy("production").automatic, true);
  assert.equal(runtime.resolveDesktopUpdatePolicy("preview").automatic, false);
});

test("Codex remote routing passes the bundle root without legacy CDN or mock fallback", async (t) => {
  const { module: runtime, directory } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopProductRuntime.ts",
  );
  const options = {
    resourcesPath: join(directory, "resources"),
    desktopRoot: join(directory, "desktop"),
    cacheDir: join(directory, "shared-override-cache"),
  };
  for (const isPackaged of [true, false]) {
    assert.deepEqual(runtime.resolveCodexRemoteAssetDirs({ ...options, isPackaged }), {
      bundledRemoteAssetsDir: isPackaged
        ? join(options.resourcesPath, "codex-remote")
        : join(options.desktopRoot, "bundled-resources/codex-remote"),
      remoteCacheDir: join(options.cacheDir, "codex"),
    });
  }
});

test("Codex deep links accept only the fork scheme, including encoded argv", async (t) => {
  const { module: links } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopDeepLinkUrl.ts",
  );
  const url = "zcode-codex://workspace/open?path=%2Ftmp%2Fworkspace";
  assert.equal(links.extractDeepLinkUrlFromArgs([encodeURIComponent(url)]), url);
  assert.equal(links.extractWorkspaceOpenPath(new URL(url)), "/tmp/workspace");
  assert.equal(links.extractDeepLinkUrlFromArgs(["zcode://workspace/open?path=/tmp"]), null);
  assert.equal(links.isOAuthCallbackUrl(new URL("zcode://oauth/callback?state=abc")), false);
  assert.equal(links.isOAuthCallbackUrl(new URL("zcode-codex://oauth/callback?state=abc")), true);
  const upstream = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopDeepLinkUrl.ts",
    "production",
  );
  assert.equal(upstream.module.extractDeepLinkUrlFromArgs([url]), null);
});

test("Linux registration neither replaces nor deletes the upstream desktop entry", async (t) => {
  const { module, directory } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts",
  );
  const applications = join(directory, ".local/share/applications");
  await mkdir(applications, { recursive: true });
  const upstream = join(applications, "zcode.desktop");
  await writeFile(upstream, "Comment=ZCode Desktop App\nupstream sentinel\n");
  const calls = [];
  module.registerLinuxDeepLinkProtocol({
    executablePath: "/opt/ZCode Codex/zcode-codex",
    homeDir: directory,
    systemApplicationDirs: [],
    env: {},
    logger: { info() {}, warn() {} },
    runCommand(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.match(await readFile(upstream, "utf8"), /upstream sentinel/);
  const entry = await readFile(join(applications, "zcode-codex.desktop"), "utf8");
  assert.match(entry, /MimeType=x-scheme-handler\/zcode-codex;/);
  assert.match(entry, /Icon=zcode-codex/);
  assert.ok(
    calls.some(([command, args]) => command === "xdg-mime" && args[1] === "zcode-codex.desktop"),
  );
});

test("Finder workflow has a separate name, bundle id and protocol", async (t) => {
  const { module, directory } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts",
  );
  module.installFinderOpenFolderWorkflow({
    platform: "darwin",
    locale: "en-US",
    homeDir: directory,
    refreshServicesIndex() {},
    logger: { info() {}, warn() {} },
  });
  const contents = join(directory, "Library/Services/Open in ZCode Codex.workflow/Contents");
  assert.match(
    await readFile(join(contents, "Info.plist"), "utf8"),
    /io.github.kingingwang.zcode.codex.finder-open-workflow/,
  );
  assert.match(
    await readFile(join(contents, "document.wflow"), "utf8"),
    /zcode-codex:\/\/workspace\/open/,
  );
});

test("early bootstrap ignores upstream settings and namespaces a fork custom root", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-bootstrap-test-"));
  t.after(() => {
    delete globalThis.__codexTestBase;
    return rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, ".zcode/v2"), { recursive: true });
  await writeFile(
    join(home, ".zcode/v2/setting.json"),
    JSON.stringify({ dataBaseDir: "/upstream-must-not-be-read" }),
  );
  const plugins = [
    {
      name: "bootstrap-ports",
      setup(build) {
        build.onResolve({ filter: /^@zcode\/services\/node$|^node:os$/ }, ({ path }) => ({
          path,
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "node:os"
              ? `export const homedir = () => ${JSON.stringify(home)};`
              : "export function setDataBaseDir(dir) { globalThis.__codexTestBase = dir; }",
        }));
      },
    },
  ];
  const { module } = await loadRuntimeModule(
    t,
    "packages/desktop/src/main/desktopDataBaseDirBootstrap.ts",
    "codex",
    plugins,
  );
  assert.equal(module.applyEarlyDataBaseDirBootstrap(), join(home, ".zcode-codex"));
  assert.equal(globalThis.__codexTestBase, join(home, ".zcode-codex"));
  const forkSettings = join(home, ".zcode-codex/.zcode/v2");
  await mkdir(forkSettings, { recursive: true });
  await writeFile(
    join(forkSettings, "setting.json"),
    JSON.stringify({ dataBaseDir: join(home, "custom") }),
  );
  assert.equal(module.applyEarlyDataBaseDirBootstrap(), join(home, "custom/.zcode-codex"));
});

test("macOS development bundle uses Codex identity and protocol", async (t) => {
  const { module } = await loadRuntimeModule(
    t,
    "packages/desktop/scripts/devElectronAppBundle.mjs",
  );
  const plist =
    "<plist><dict><key>CFBundleDisplayName</key><string>Electron</string><key>CFBundleIdentifier</key><string>com.github.Electron</string><key>CFBundleName</key><string>Electron</string></dict></plist>";
  const patched = module.patchDevElectronInfoPlist(plist);
  assert.match(patched, /ZCode Codex Dev/);
  assert.match(patched, /io.github.kingingwang.zcode.codex.development/);
  assert.match(patched, /<string>zcode-codex<\/string>/);
});
