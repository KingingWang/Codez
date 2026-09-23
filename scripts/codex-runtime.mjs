import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const codexWorkspaceRoot = resolve(import.meta.dirname, "..");
export const defaultCodexBridgePath = resolve(
  codexWorkspaceRoot,
  "packages/codex-bridge/dist/bridge.cjs",
);
export const defaultCodexStageRoot = resolve(codexWorkspaceRoot, "packages/desktop/bundled-agents");

export async function loadCodexManifest(env = process.env) {
  // CI 发布通过 CODEZ_CODEX_MANIFEST 指向本次 run 解析出的 fork 最新 release 清单；
  // 本地开发默认使用仓库内固定的回退清单（见 codex-runtime-resolve-latest.mjs）。
  const override = env.CODEZ_CODEX_MANIFEST?.trim();
  const source = override
    ? resolve(override)
    : new URL("./codex-runtime-manifest.json", import.meta.url);
  return JSON.parse(await readFile(source, "utf8"));
}

export function resolveCodexTarget(env = process.env) {
  const osAliases = {
    darwin: "darwin",
    mac: "darwin",
    macos: "darwin",
    osx: "darwin",
    linux: "linux",
    win: "win32",
    windows: "win32",
    win32: "win32",
  };
  const archAliases = { x64: "x64", amd64: "x64", x86_64: "x64", arm64: "arm64", aarch64: "arm64" };
  const rawOs = (env.CODEZ_TARGET_OS ?? process.platform).toLowerCase();
  const rawArch = (env.CODEZ_TARGET_ARCH ?? process.arch).toLowerCase();
  const os = Object.hasOwn(osAliases, rawOs) ? osAliases[rawOs] : null;
  const arch = Object.hasOwn(archAliases, rawArch) ? archAliases[rawArch] : null;
  if (!os || !arch) throw new Error(`Unsupported Codex target: ${rawOs}-${rawArch}`);
  return { os, arch, key: `${os}-${arch}` };
}

export function selectCodexAsset(manifest, target) {
  if (
    !/^(darwin|linux|win32)-(x64|arm64)$/.test(target.key) ||
    target.key !== `${target.os}-${target.arch}`
  ) {
    throw new Error("Invalid Codex target key");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== "KingingWang/codex" ||
    !/^codex-\d{8}-\d{6}$/.test(manifest.tag)
  ) {
    throw new Error("Invalid pinned Codex release manifest");
  }
  const asset = manifest.assets[target.key];
  const osName = { darwin: "macos", linux: "linux", win32: "windows" }[target.os];
  const archName = target.arch === "x64" ? "x86_64" : "aarch64";
  const suffix = target.os === "linux" ? "-musl" : target.os === "win32" ? ".exe" : "";
  if (
    !asset ||
    asset.name !== `codex-${osName}-${archName}${suffix}` ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  ) {
    throw new Error(`Invalid Codex asset for ${target.key}`);
  }
  return {
    ...asset,
    binaryName: target.os === "win32" ? "codex.exe" : "codex",
    url: `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${asset.name}`,
  };
}

export async function sha256File(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function snapshotCodexBridge({
  bridgePath = defaultCodexBridgePath,
  root = defaultCodexStageRoot,
} = {}) {
  const digest = await sha256File(bridgePath);
  const parent = join(root, "bridges");
  const directory = join(parent, digest);
  const snapshot = join(directory, "bridge.cjs");
  try {
    if ((await sha256File(snapshot)) !== digest)
      throw new Error("Bridge snapshot checksum mismatch");
    return snapshot;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".bridge-snapshot-"));
  try {
    await copyFile(bridgePath, join(temporary, "bridge.cjs"));
    if ((await sha256File(join(temporary, "bridge.cjs"))) !== digest)
      throw new Error("Bridge changed while snapshotting");
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) ||
        (await sha256File(snapshot)) !== digest
      )
        throw error;
    }
    return snapshot;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function publishCodexBuildSelection({
  directory,
  target = resolveCodexTarget(),
  root = defaultCodexStageRoot,
  manifest,
} = {}) {
  await verifyCodexResources({ directory, target, manifest });
  const parent = join(root, target.key);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".selection-"));
  try {
    await copyFile(join(directory, "distribution.json"), join(temporary, "selection.json"));
    await rename(join(temporary, "selection.json"), join(parent, "selection.json"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveCodexBuildSelection({
  root = defaultCodexStageRoot,
  target = resolveCodexTarget(),
  manifest,
} = {}) {
  let selection;
  try {
    selection = JSON.parse(await readFile(join(root, target.key, "selection.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return resolveCodexStaging({ root, target, manifest });
    throw error;
  }
  manifest ??= await loadCodexManifest();
  const asset = selectCodexAsset(manifest, target);
  if (
    selection.target !== target.key ||
    selection.tag !== manifest.tag ||
    selection.sha256 !== asset.sha256 ||
    !/^[a-f0-9]{64}$/.test(selection.bridgeSha256)
  )
    throw new Error("Invalid Codex build selection");
  const directory = join(root, target.key, `codex-${asset.sha256}-${selection.bridgeSha256}`);
  const result = { directory, target, manifest, asset, bridgeSha256: selection.bridgeSha256 };
  await verifyCodexResources(result);
  return result;
}

export async function verifyCodexBinary(path, asset) {
  if ((await lstat(path)).size !== asset.size) throw new Error("Codex binary size mismatch");
  if ((await sha256File(path)) !== asset.sha256) throw new Error("Codex binary checksum mismatch");
}

const downloadAttempts = 4;
const downloadRetryBaseMs = 1_500;

function integrityError(message) {
  return Object.assign(new Error(message), { codexIntegrity: true });
}

/** 完整性问题必须 fail closed；只有网络重置、超时、429 与 5xx 属于可重试的瞬时故障。 */
function retryableDownloadError(error) {
  if (error?.codexIntegrity) return false;
  const status = Number(error?.codexStatus ?? 0);
  return status === 0 || status === 429 || status >= 500;
}

export async function downloadVerifiedBinary(
  path,
  asset,
  fetchImpl,
  {
    attempts = downloadAttempts,
    retryDelay = (attempt) =>
      new Promise((done) => setTimeout(done, attempt * downloadRetryBaseMs)),
  } = {},
) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadVerifiedAttempt(path, asset, fetchImpl);
      return;
    } catch (error) {
      if (!retryableDownloadError(error)) throw error;
      failure = error;
      // Release CDN 的 ECONNRESET/5xx 会让整条原生流水线白跑十几分钟；有界重试即可恢复。
      if (attempt === attempts) break;
      await rm(path, { force: true });
      await retryDelay(attempt);
    }
  }
  throw failure;
}

async function downloadVerifiedAttempt(path, asset, fetchImpl) {
  const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body)
    throw Object.assign(new Error(`Codex download failed: HTTP ${response.status}`), {
      codexStatus: response.status,
    });
  let size = 0;
  const hash = createHash("sha256");
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > asset.size)
        return callback(integrityError("Codex download size exceeds manifest"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verifier,
    createWriteStream(path, { flags: "wx", mode: 0o755 }),
  );
  if (size !== asset.size) throw integrityError("Codex download size mismatch");
  if (hash.digest("hex") !== asset.sha256) throw integrityError("Codex download checksum mismatch");
  await chmod(path, 0o755);
}

export async function stageCodexBinary({
  root = defaultCodexStageRoot,
  target = resolveCodexTarget(),
  manifest,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (env.CODEZ_CODEX_BINARY || env.CODEX_BINARY_PATH)
    throw new Error("Distribution does not accept a local Codex binary override");
  manifest ??= await loadCodexManifest();
  const asset = selectCodexAsset(manifest, target);
  const parent = join(root, target.key);
  const directory = join(parent, `codex-${asset.sha256}`);
  const binary = join(directory, asset.binaryName);
  try {
    await verifyCodexBinary(binary, asset);
    return binary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".codex-download-"));
  try {
    await downloadVerifiedBinary(join(temporary, asset.binaryName), asset, fetchImpl);
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await verifyCodexBinary(binary, asset);
    }
    return binary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveCodexStaging({
  root = defaultCodexStageRoot,
  bridgePath = defaultCodexBridgePath,
  target = resolveCodexTarget(),
  manifest,
} = {}) {
  manifest ??= await loadCodexManifest();
  const asset = selectCodexAsset(manifest, target);
  const bridgeSha256 = await sha256File(bridgePath);
  // 内容寻址目录不覆盖旧版本：先校验完整二元组，再以一次 rename 原子发布。
  const directory = join(root, target.key, `codex-${asset.sha256}-${bridgeSha256}`);
  return { directory, bridgeSha256, asset, manifest, target };
}

export async function verifyCodexResources({
  directory,
  target = resolveCodexTarget(),
  manifest,
  bridgeSha256,
} = {}) {
  manifest ??= await loadCodexManifest();
  const asset = selectCodexAsset(manifest, target);
  const binary = join(directory, asset.binaryName);
  await verifyCodexBinary(binary, asset);
  const metadata = JSON.parse(await readFile(join(directory, "distribution.json"), "utf8"));
  if (
    metadata.target !== target.key ||
    metadata.tag !== manifest.tag ||
    metadata.sha256 !== asset.sha256
  )
    throw new Error("Codex staging metadata mismatch");
  const actualBridge = await sha256File(join(directory, "bridge.cjs"));
  if (actualBridge !== metadata.bridgeSha256 || (bridgeSha256 && actualBridge !== bridgeSha256))
    throw new Error("Codex bridge checksum mismatch");
  return { binary, bridge: join(directory, "bridge.cjs") };
}

export async function stageCodexRuntime({
  root = defaultCodexStageRoot,
  bridgePath = defaultCodexBridgePath,
  target = resolveCodexTarget(),
  manifest,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (env.CODEZ_CODEX_BINARY || env.CODEX_BINARY_PATH)
    throw new Error("Distribution does not accept a local Codex binary override");
  const plan = await resolveCodexStaging({ root, bridgePath, target, manifest });
  try {
    await lstat(plan.directory);
    await verifyCodexResources(plan);
    return plan.directory;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = join(root, target.key);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".codex-stage-"));
  try {
    const binary = await stageCodexBinary({
      root,
      target,
      manifest: plan.manifest,
      fetchImpl,
      env,
    });
    await copyFile(binary, join(temporary, plan.asset.binaryName));
    await copyFile(bridgePath, join(temporary, "bridge.cjs"));
    await writeFile(
      join(temporary, "distribution.json"),
      `${JSON.stringify({ target: target.key, tag: plan.manifest.tag, sha256: plan.asset.sha256, bridgeSha256: plan.bridgeSha256 }, null, 2)}\n`,
    );
    await verifyCodexResources({ ...plan, directory: temporary });
    try {
      await rename(temporary, plan.directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      // 并行准备只能复用已完整发布且校验相同的目录，不能覆盖另一个构建的资产。
      await verifyCodexResources(plan);
    }
    return plan.directory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
