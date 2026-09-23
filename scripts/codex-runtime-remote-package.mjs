import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { runCodexTar } from "./codex-runtime-archive.mjs";
import {
  codexWorkspaceRoot,
  resolveCodexTarget,
  sha256File,
  stageCodexRuntime,
  verifyCodexResources,
} from "./codex-runtime.mjs";
import { stageCodexRemoteNode } from "./codex-runtime-node.mjs";
import { codexRemoteDeploymentContract } from "./codex-runtime-remote.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";

const run = promisify(execFile);
const serverRoot = resolve(codexWorkspaceRoot, "packages/server");
const require = createRequire(join(serverRoot, "package.json"));

export async function buildCodexRemoteServer() {
  await run(process.execPath, [require.resolve("tsx/cli"), "build-remote.ts"], {
    cwd: serverRoot,
    env: { ...process.env, CODEZ_DESKTOP_RUNTIME: "codex" },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  return join(serverRoot, "dist/remote/codez-server.cjs");
}

export async function copyCodexRemoteServer(directory) {
  for (const file of ["codez-server.cjs", "THIRD-PARTY-NOTICES.md"]) {
    await copyFile(join(serverRoot, "dist/remote", file), join(directory, file));
  }
}

async function prepareServer(directory) {
  await buildCodexRemoteServer();
  await copyCodexRemoteServer(directory);
}

async function preparePty(directory, target) {
  const source = resolve(
    dirname(require.resolve(`@lydell/node-pty-${target.key}`)),
    "../prebuilds",
    target.key,
  );
  const destination = join(directory, "prebuilds", target.key);
  await mkdir(destination, { recursive: true });
  await copyFile(join(source, "pty.node"), join(destination, "pty.node"));
  if (target.os === "darwin") {
    await copyFile(join(source, "spawn-helper"), join(destination, "spawn-helper"));
    await chmod(join(destination, "spawn-helper"), 0o755);
  }
}

async function hashTree(directory, prefix = "", result = {}) {
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await hashTree(directory, name, result);
    else if (entry.isFile()) result[name] = await sha256File(join(directory, name));
    else throw new Error(`Unsupported remote package entry: ${name}`);
  }
  return result;
}

export async function prepareCodexRemotePackage({
  target = resolveCodexTarget(),
  outputRoot = resolve(codexWorkspaceRoot, "packages/desktop/bundled-resources/codex-remote"),
  stagingOptions = {},
  prepareServerImpl = prepareServer,
  prepareNodeImpl = stageCodexRemoteNode,
  preparePtyImpl = preparePty,
  prepareSearchImpl = prepareNativeSearchTools,
  publishComponents = false,
} = {}) {
  if (
    !/^(linux|darwin)-(x64|arm64)$/.test(target.key) ||
    target.key !== `${target.os}-${target.arch}`
  )
    throw new Error("Unsupported remote package target");
  const codexDirectory = await stageCodexRuntime({ ...stagingOptions, target });
  await verifyCodexResources({ ...stagingOptions, directory: codexDirectory, target });
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, ".remote-package-"));
  const directory = join(temporary, "runtime");
  await mkdir(directory);
  try {
    await cp(codexDirectory, join(directory, "codex"), { recursive: true });
    await prepareServerImpl(directory);
    const node = await prepareNodeImpl({ directory, target });
    await preparePtyImpl(directory, target);
    const searchPlan = resolveRemoteNativeSearchPrebuiltPlan({
      platform: target.os,
      arch: target.arch,
      outputDir: join(directory, "tools"),
    });
    await prepareSearchImpl({ ...searchPlan, prebuiltPlan: searchPlan });
    const files = await hashTree(directory);
    const descriptor = {
      schemaVersion: 1,
      product: "codez-codex",
      platformArch: target.key,
      ...codexRemoteDeploymentContract,
      runtimeRoot: "~/.codez-codex/server",
      node,
      files,
      searchComponents: searchPlan.artifacts.map(({ toolId, release }) => ({
        id: toolId,
        version: release,
      })),
      command: ["<runtimeRoot>/node", "<runtimeRoot>/codez-server.cjs"],
      requiredEnv: {
        CODEZ_DESKTOP_RUNTIME: "codex",
        CODEZ_SERVER_RUNTIME_ROOT: "<runtimeRoot>",
        CODEZ_CODEX_BRIDGE_PATH: "<runtimeRoot>/codex/bridge.cjs",
        CODEZ_CODEX_COMMAND: "<runtimeRoot>/codex/codex",
        CODEZ_CODEX_BRIDGE_HOME: "~/.codez-codex/bridge",
        CODEZ_DATA_BASE_DIR: "~/.codez-codex",
        CODEZ_HOME: "~/.codez-codex/.codez",
      },
    };
    await writeFile(
      join(directory, "runtime-package.json"),
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    if (publishComponents)
      return await publishCodexRemoteComponents({ directory, descriptor, outputRoot, temporary });
    const archive = join(temporary, "runtime.tar.gz");
    await runCodexTar({ mode: "create", archivePath: archive, directory, entries: ["."] });
    const sha256 = await sha256File(archive);
    descriptor.sha256 = sha256;
    descriptor.artifactPath = `codex-server-${target.key}-${sha256}.tar.gz`;
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
    await rename(archive, join(outputRoot, descriptor.artifactPath));
    await rename(
      join(temporary, "manifest.json"),
      join(outputRoot, `codex-server-${target.key}.json`),
    );
    return descriptor;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function publishCodexRemoteComponents({
  directory,
  descriptor,
  outputRoot,
  temporary,
}) {
  const { version: appVersion } = JSON.parse(
    await readFile(join(codexWorkspaceRoot, "package.json"), "utf8"),
  );
  const key = descriptor.platformArch;
  const grouped = join(temporary, "groups");
  for (const [group, names] of [
    ["server", ["codez-server.cjs", "THIRD-PARTY-NOTICES.md"]],
    ["node", ["node", "LICENSE.node.txt", "NODE-SOURCES.json"]],
  ]) {
    await mkdir(join(grouped, group), { recursive: true });
    for (const name of names) await copyFile(join(directory, name), join(grouped, group, name));
  }
  const definitions = [
    ["server-bundle", "server", join(grouped, "server")],
    ["node-runtime", `node/${key}`, join(grouped, "node")],
    ["node-pty", `node-pty/${key}`, join(directory, "prebuilds", key)],
    ["codex-runtime", "codex", join(directory, "codex")],
    ...descriptor.searchComponents.map(({ id }) => [
      id,
      `tools/${key}/${id}`,
      join(directory, "tools", id),
    ]),
  ];
  const components = [];
  const ptyPackage = JSON.parse(
    await readFile(
      resolve(dirname(require.resolve(`@lydell/node-pty-${key}`)), "../package.json"),
      "utf8",
    ),
  );
  const codex = JSON.parse(await readFile(join(directory, "codex/distribution.json"), "utf8"));
  const versions = {
    "server-bundle": appVersion,
    "node-runtime": "24.14.0",
    "node-pty": ptyPackage.version,
    "codex-runtime": codex.tag,
    ...Object.fromEntries(descriptor.searchComponents.map(({ id, version }) => [id, version])),
  };
  for (const [id, mount, source] of definitions) {
    const archive = join(temporary, `${id}.tar.gz`);
    await runCodexTar({ mode: "create", archivePath: archive, directory: source, entries: ["."] });
    const sha256 = await sha256File(archive);
    const artifactPath = `components/${key}/${id}/${sha256}.tar.gz`;
    await mkdir(dirname(join(outputRoot, artifactPath)), { recursive: true });
    await rename(archive, join(outputRoot, artifactPath));
    components.push({
      id,
      version: `${versions[id]}+${sha256.slice(0, 12)}`,
      sha256,
      artifactPath,
      mount,
    });
  }
  const manifest = { schemaVersion: 1, appVersion, platformArch: key, components };
  const releaseRoot = join(outputRoot, "releases", appVersion);
  await mkdir(releaseRoot, { recursive: true });
  await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(join(temporary, "manifest.json"), join(releaseRoot, `manifest-${key}.json`));
  await writeFile(join(temporary, "contract.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  await rename(join(temporary, "contract.json"), join(releaseRoot, `runtime-${key}.json`));
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bridgePath = await buildCodexBridge();
  console.log(
    JSON.stringify(await prepareCodexRemotePackage({ stagingOptions: { bridgePath } }), null, 2),
  );
}
