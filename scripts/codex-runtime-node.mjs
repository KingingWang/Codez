import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { sha256File } from "./codex-runtime.mjs";
import { stageNodeNotices } from "./third-party-notices.mjs";

const run = promisify(execFile);
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

export async function stageCodexRemoteNode({ directory, target, manifest, fetchImpl = fetch }) {
  manifest ??= await loadCodexNodeManifest();
  const asset = selectCodexNodeAsset(manifest, target);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".node-"));
  try {
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Node download HTTP ${response.status}`);
    const archive = join(temporary, "node.tar.gz");
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(
            size > 150 * 1024 * 1024 ? new Error("Node archive exceeds size limit") : null,
            chunk,
          );
        },
      }),
      createWriteStream(archive, { flags: "wx" }),
    );
    if ((await sha256File(archive)) !== asset.sha256)
      throw new Error("Node archive checksum mismatch");
    // 只在固定发行包校验通过后解出确定的单一成员，禁止把任意归档路径发布到运行目录。
    await run(
      "tar",
      ["-xzf", archive, "-C", temporary, "--strip-components=2", `${asset.name}/bin/node`],
      { shell: false },
    );
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
