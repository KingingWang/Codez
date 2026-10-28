import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runCodexTar } from "./codex-runtime-archive.mjs";
import { sha256File } from "./codex-runtime.mjs";
import { stageNodeNotices } from "./third-party-notices.mjs";

const downloadAttempts = 4;
const retryBaseMs = 1_500;
const archiveSizeLimit = 150 * 1024 * 1024;

function retryableNodeDownloadError(error, signal) {
  if (error?.nodeArchiveIntegrity) return false;
  if (error?.nodeDownloadStatus !== undefined)
    return error.nodeDownloadStatus === 429 || error.nodeDownloadStatus >= 500;
  if (signal.aborted && signal.reason?.name === "TimeoutError") return true;
  const code = error?.code ?? error?.cause?.code;
  return (
    error?.name === "TimeoutError" ||
    error?.cause?.name === "TimeoutError" ||
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EPIPE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ].includes(code) ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
}

async function downloadVerifiedNodeArchive(archive, asset, fetchImpl, retryDelay) {
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    const signal = AbortSignal.timeout(180_000);
    try {
      const response = await fetchImpl(asset.url, { signal });
      if (!response.ok || !response.body)
        throw Object.assign(new Error(`Node download HTTP ${response.status}`), {
          nodeDownloadStatus: response.status,
        });
      let size = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(
              size > archiveSizeLimit
                ? Object.assign(new Error("Node archive exceeds size limit"), {
                    nodeArchiveIntegrity: true,
                  })
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(archive, { flags: "wx" }),
      );
      if ((await sha256File(archive)) !== asset.sha256)
        throw Object.assign(new Error("Node archive checksum mismatch"), {
          nodeArchiveIntegrity: true,
        });
      return;
    } catch (error) {
      if (attempt === downloadAttempts || !retryableNodeDownloadError(error, signal)) throw error;
      // 原因：远端 Node 下载的 180 秒超时此前会直接中止全部四目标构建；
      // 只对瞬时网络故障重试，先移除可能残留的归档，校验失败仍立即拒绝。
      await rm(archive, { force: true });
      console.warn(
        `[codex-remote-node] retrying archive download (${asset.name}, ${attempt}/${downloadAttempts})`,
      );
      await retryDelay(attempt);
    }
  }
}

export async function loadCodexNodeManifest() {
  return JSON.parse(
    await readFile(new URL("./codex-runtime-node-manifest.json", import.meta.url), "utf8"),
  );
}

export function selectCodexNodeAsset(manifest, target) {
  if (
    !/^(darwin|linux)-(x64|arm64)$/.test(target.key) ||
    target.key !== `${target.os}-${target.arch}`
  )
    throw new Error("Unsupported remote Node target");
  const sha256 = manifest.assets[target.key];
  if (manifest.version !== "24.14.0" || !/^[a-f0-9]{64}$/.test(sha256 ?? ""))
    throw new Error("Invalid pinned remote Node manifest");
  const name = `node-v${manifest.version}-${target.key}`;
  return { name, sha256, url: `https://nodejs.org/dist/v${manifest.version}/${name}.tar.gz` };
}

export async function stageCodexRemoteNode({
  directory,
  target,
  manifest,
  fetchImpl = fetch,
  retryDelay = (attempt) => new Promise((done) => setTimeout(done, attempt * retryBaseMs)),
}) {
  manifest ??= await loadCodexNodeManifest();
  const asset = selectCodexNodeAsset(manifest, target);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".node-"));
  try {
    const archive = join(temporary, "node.tar.gz");
    await downloadVerifiedNodeArchive(archive, asset, fetchImpl, retryDelay);
    // 只在固定发行包校验通过后解出确定的单一成员，禁止把任意归档路径发布到运行目录。
    await runCodexTar({
      mode: "extract",
      archivePath: archive,
      directory: temporary,
      stripComponents: 2,
      entries: [`${asset.name}/bin/node`],
    });
    const binary = join(temporary, "node");
    const binarySha256 = await sha256File(binary);
    await chmod(binary, 0o755);
    await stageNodeNotices(directory, manifest.version);
    await rename(binary, join(directory, "node"));
    return { version: manifest.version, archiveSha256: asset.sha256, binarySha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
