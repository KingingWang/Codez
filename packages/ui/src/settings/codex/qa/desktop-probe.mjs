// Isolated actual desktop dev entry. No build preparation, metadata overrides or real account state.
import { mkdtemp, mkdir, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startDesktopMockProvider } from "./desktop-mock-provider.mjs";
import { isolatedElectronSandboxEnv } from "./desktop-probe-env.mjs";
import { assertQaCdpPortAvailable } from "./desktop-probe-ports.mjs";
import { createMappedProviderQaConfig } from "./desktop-mapped-provider-config.mjs";
const root = process.cwd();
const packaged = process.env.CODEX_UI_QA_PACKAGED === "1";
function qaPort(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535)
    throw new Error(`Invalid isolated QA port: ${name}`);
  return parsed;
}
const rendererPort = qaPort("CODEX_UI_QA_RENDERER_PORT", 5174);
const cdpPort = qaPort("CODEX_UI_QA_CDP_PORT", packaged ? 9230 : 9229);
await assertQaCdpPortAvailable(cdpPort);
const parallelProbe = !packaged && (rendererPort !== 5174 || cdpPort !== 9229);
const packagedRoot = resolve(root, "packages/desktop/dist/linux-unpacked");
const packagedExecutable = join(packagedRoot, "codez-codex");
const isolated = await mkdtemp(join(tmpdir(), "codex-ui-qa-"));
for (const name of ["home", "config", "data", "cache", "codex", "workspace", "session", "userData"])
  await mkdir(join(isolated, name));
const mock =
  process.env.CODEX_UI_QA_MOCK === "1"
    ? await startDesktopMockProvider({ reuseItemId: process.env.CODEX_UI_QA_REUSE_ITEM_ID === "1" })
    : null;
const mappedConfig =
  process.env.CODEX_UI_QA_MAPPED_PROVIDER === "1"
    ? createMappedProviderQaConfig(
        join(isolated, "codex/catalog.json"),
        mock?.url ?? "http://127.0.0.1:9",
      )
    : null;
if (mappedConfig)
  await writeFile(join(isolated, "codex/catalog.json"), JSON.stringify(mappedConfig.catalog));
await writeFile(
  join(isolated, "codex/config.toml"),
  mappedConfig?.config ??
    `model_provider = "ui_qa"\nmodel = "ui-qa-offline"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.ui_qa]\nname = "Isolated UI QA"\nbase_url = "${mock?.url ?? "http://127.0.0.1:9"}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n${mock ? "request_max_retries = 0\n" : ""}[analytics]\nenabled = false\n`,
);
let nativeOverride;
if (packaged) {
  await Promise.all([
    access(packagedExecutable),
    access(join(packagedRoot, "resources/app.asar")),
    access(join(packagedRoot, "resources/codex/bridge.cjs")),
    access(join(packagedRoot, "resources/codex/codex")),
  ]);
} else {
  const manifest = JSON.parse(
    await readFile(resolve(root, "scripts/codex-runtime-manifest.json"), "utf8"),
  );
  nativeOverride = resolve(
    root,
    "packages/desktop/bundled-agents/linux-x64",
    `codex-${manifest.assets["linux-x64"].sha256}`,
    "codex",
  );
  await access(nativeOverride);
}
const env = {
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  HOME: join(isolated, "home"),
  XDG_CONFIG_HOME: join(isolated, "config"),
  XDG_DATA_HOME: join(isolated, "data"),
  XDG_CACHE_HOME: join(isolated, "cache"),
  CODEX_HOME: join(isolated, "codex"),
  CODEZ_DATA_BASE_DIR: join(isolated, "data"),
  CODEZ_DESKTOP_RUNTIME: "codex",
  CODEZ_DESKTOP_APPLICATION_NAME: "Codex UI QA",
  CODEZ_DESKTOP_HOME_DIR: join(isolated, "home"),
  CODEZ_DESKTOP_USER_DATA_DIR: join(isolated, "userData"),
  CODEZ_DESKTOP_SESSION_DATA_DIR: join(isolated, "session"),
  ...(parallelProbe
    ? {
        CODEZ_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
        ELECTRON_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
      }
    : {}),
  ...isolatedElectronSandboxEnv(process.platform, process.getuid?.()),
  ...(nativeOverride ? { CODEZ_CODEX_COMMAND: nativeOverride } : {}),
};
const display = spawn(
  "Xvfb",
  ["-displayfd", "3", "-screen", "0", "1440x1000x24", "-nolisten", "tcp"],
  {
    env,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  },
);
env.DISPLAY = await new Promise((resolveDisplay, reject) => {
  let output = "";
  display.stdio[3].on("data", (chunk) => {
    output += String(chunk);
    if (output.includes("\n")) resolveDisplay(`:${output.trim()}`);
  });
  display.once("error", reject);
  display.once("exit", (code) => reject(new Error(`Xvfb exited before launch: ${code}`)));
});
// The default probe uses dev.mjs. Parallel QA attaches an isolated Electron to
// its own renderer/CDP ports, leaving other worktree GUI sessions untouched.
// Isolation must not bypass real package/updater startup validation.
// 打包验收不覆盖 bridge/native 路径；临时 cwd 也不能回溯到源码树 resolver fallback。
const require = createRequire(import.meta.url);
const electronPackageRoot = resolve(require.resolve("electron/package.json"), "..");
const app = spawn(
  packaged
    ? packagedExecutable
    : parallelProbe
      ? join(electronPackageRoot, "dist", "electron")
      : process.execPath,
  packaged
    ? [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"]
    : parallelProbe
      ? [".", `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"]
      : ["scripts/dev.mjs"],
  {
    cwd: packaged ? join(isolated, "workspace") : resolve(root, "packages/desktop"),
    env,
    stdio: "inherit",
  },
);
console.log(
  JSON.stringify({
    isolated,
    cdp: `http://127.0.0.1:${cdpPort}`,
    devPid: app.pid,
    entry: packaged
      ? packagedExecutable
      : parallelProbe
        ? join(electronPackageRoot, "dist", "electron")
        : "packages/desktop/scripts/dev.mjs",
    mockProvider: mock?.url,
  }),
);
const stop = () => {
  app.kill();
  display.kill();
  mock?.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
app.on("exit", (code) => {
  display.kill();
  mock?.close();
  process.exitCode = code ?? 1;
});
