import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { codexWorkspaceRoot, resolveCodexTarget } from "./codex-runtime.mjs";
import { codexRemoteRoot, verifyCodexRemoteAssets } from "./codex-runtime-remote-verify.mjs";

const run = promisify(execFile);
const require = createRequire(join(codexWorkspaceRoot, "packages/server/package.json"));
export async function smokeCodexRemoteBundle(root = codexRemoteRoot) {
  const target = resolveCodexTarget({});
  if (target.os === "win32")
    throw new Error("Remote server smoke requires a native macOS/Linux runner");
  await verifyCodexRemoteAssets({ root });
  const { version } = JSON.parse(await readFile(join(codexWorkspaceRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(join(root, "releases", version, `manifest-${target.key}.json`), "utf8"),
  );
  const directory = await mkdtemp(join(tmpdir(), "codez-codex-remote-smoke-"));
  try {
    const consumerModule = pathToFileURL(
      join(codexWorkspaceRoot, "packages/server/src/remote/bundledRemoteAssets.ts"),
    ).href;
    const options = {
      bundledRemoteAssetsDir: root,
      remoteCacheDir: join(directory, "cache"),
      version,
      platformArch: target.key,
    };
    // 与真实部署共用 consumer，防止 smoke 手工解包通过却漏掉目标隔离/校验接口回归。
    const materialize = `
      (async () => {
        const { createBundledRemoteAssetSource } = await import(${JSON.stringify(consumerModule)});
        const source = createBundledRemoteAssetSource(${JSON.stringify(options)}, { log() {}, logWarn() {} });
        const release = await source.materialize(${JSON.stringify(manifest.components.map(({ id }) => id))});
        process.stdout.write(JSON.stringify(release));
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = await run(process.execPath, [require.resolve("tsx/cli"), "-e", materialize], {
      cwd: codexWorkspaceRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    const release = JSON.parse(result.stdout);
    for (const component of manifest.components) {
      const mount =
        component.id === "node-pty"
          ? `prebuilds/${target.key}`
          : ["server-bundle", "node-runtime"].includes(component.id)
            ? "."
            : component.id === "codex-runtime"
              ? "codex"
              : `tools/${component.id}`;
      const destination = join(directory, mount);
      await mkdir(destination, { recursive: true });
      await cp(join(release, component.mount), destination, { recursive: true });
    }
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      CODEZ_DESKTOP_RUNTIME: "codex",
      CODEZ_DATA_BASE_DIR: join(directory, "data"),
      CODEZ_CODEX_BRIDGE_HOME: join(directory, "bridge-home"),
      CODEZ_CODEX_COMMAND: join(directory, "codex/codex"),
      CODEZ_CODEX_BRIDGE_PATH: join(directory, "codex/bridge.cjs"),
    };
    const binary = join(directory, "node");
    const node = await run(binary, ["--version"], { env, cwd: directory, timeout: 15_000 });
    if (node.stdout.trim() !== "v24.14.0") throw new Error("Remote Node pin mismatch");
    const server = await run(binary, [join(directory, "codez-server.cjs"), "--version"], {
      env,
      cwd: directory,
      timeout: 15_000,
    });
    if (server.stdout.trim() !== version)
      throw new Error(`Remote server version mismatch: ${server.stdout}`);
    console.log(
      `[codex-remote-smoke] ${target.key}: real bundled consumer materialized verified archives; Node ${node.stdout.trim()}, standalone server ${version}, packaged native dependencies resolved`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await smokeCodexRemoteBundle();
