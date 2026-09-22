// Isolated actual desktop dev entry. No build preparation, metadata overrides or real account state.
import { mkdtemp, mkdir, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { startDesktopMockProvider } from "./desktop-mock-provider.mjs";
const root = process.cwd();
const isolated = await mkdtemp(join(tmpdir(), "codex-ui-qa-"));
for (const name of ["home", "config", "data", "cache", "codex", "workspace", "session", "userData"])
  await mkdir(join(isolated, name));
const mock = process.env.CODEX_UI_QA_MOCK === "1" ? await startDesktopMockProvider() : null;
await writeFile(
  join(isolated, "codex/config.toml"),
  `model_provider = "ui_qa"\nmodel = "ui-qa-offline"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.ui_qa]\nname = "Isolated UI QA"\nbase_url = "${mock?.url ?? "http://127.0.0.1:9"}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`,
);
const nativeRoot = resolve(root, "packages/desktop/bundled-agents/linux-x64");
const manifest = JSON.parse(
  await readFile(resolve(root, "scripts/codex-runtime-manifest.json"), "utf8"),
);
const nativeName = `codex-${manifest.assets["linux-x64"].sha256}`;
await access(join(nativeRoot, nativeName, "codex"));
const env = {
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  HOME: join(isolated, "home"),
  XDG_CONFIG_HOME: join(isolated, "config"),
  XDG_DATA_HOME: join(isolated, "data"),
  XDG_CACHE_HOME: join(isolated, "cache"),
  CODEX_HOME: join(isolated, "codex"),
  ZCODE_DATA_BASE_DIR: join(isolated, "data"),
  ZCODE_DESKTOP_RUNTIME: "codex",
  ZCODE_DESKTOP_APPLICATION_NAME: "Codex UI QA",
  ZCODE_DESKTOP_HOME_DIR: join(isolated, "home"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(isolated, "userData"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(isolated, "session"),
  ZCODE_CODEX_COMMAND: join(nativeRoot, nativeName, "codex"),
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
// dev.mjs owns Electron ['.'], build readiness, renderer URL and child process cleanup.
// Isolation must not bypass real package/updater startup validation.
const app = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: resolve(root, "packages/desktop"),
  env,
  stdio: "inherit",
});
console.log(
  JSON.stringify({
    isolated,
    cdp: "http://127.0.0.1:9229",
    devPid: app.pid,
    entry: "packages/desktop/scripts/dev.mjs",
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
