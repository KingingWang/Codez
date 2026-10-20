/**
 * 官方插件 zip 制品的下载、SHA-256 校验与安全解压。
 *
 * 桥以单文件 bundle 部署（含远端宿主），不跨包复用 apps/codez-cli 的
 * zip-source；此处按同一安全基线自包含实现：目录穿越/绝对路径/符号链接
 * 一律拒绝，条目数与解压总量设上限。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

const ZIP_EXTRACT_MAX_BYTES = 512 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;

export class OfficialPluginPackageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OfficialPluginPackageError";
  }
}

export interface OfficialCatalogFetcher {
  fetchText(url: string): Promise<string>;
  fetchBuffer(url: string): Promise<Buffer>;
}

export class DefaultOfficialCatalogFetcher implements OfficialCatalogFetcher {
  async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok)
      throw new OfficialPluginPackageError("catalog request failed", response.status);
    return await response.text();
  }

  async fetchBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok)
      throw new OfficialPluginPackageError("artifact request failed", response.status);
    return Buffer.from(await response.arrayBuffer());
  }
}

export function verifySha256(buffer: Buffer, expected: string): void {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    throw new OfficialPluginPackageError("artifact SHA-256 does not match the catalog pin");
  }
}

export interface ExtractedOfficialPlugin {
  /** 解压出的插件根目录（zip 内唯一顶层目录）。 */
  pluginDir: string;
  /** 暂存根目录，调用方负责移动或删除。 */
  stagingRoot: string;
}

/**
 * 解压 zip 到临时目录。zip 内必须只有一个顶层目录（官方发布格式 `<name>/...`），
 * 任何绝对路径、`..` 穿越、符号链接条目都会让整次解压失败。
 */
export async function extractOfficialPluginZip(
  zip: Buffer,
  stagingParent?: string,
): Promise<ExtractedOfficialPlugin> {
  // 调用方传入与最终目标同文件系统的暂存父目录，保证后续 rename 原子且不会 EXDEV。
  const parent = stagingParent ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, ".extract-"));
  try {
    const zipFile = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
      yauzl.fromBuffer(
        zip,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, result) => (error || !result ? reject(error) : resolvePromise(result)),
      );
    });
    const topLevels = new Set<string>();
    let totalBytes = 0;
    let entryCount = 0;
    await new Promise<void>((resolvePromise, reject) => {
      zipFile.once("end", () => resolvePromise());
      zipFile.once("error", reject);
      zipFile.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          try {
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES)
              throw new OfficialPluginPackageError("zip has too many entries");
            const fileName: string = entry.fileName;
            // 拒绝绝对路径与穿越；normalize 后再校验，防止 a/../b 之类。
            if (
              fileName.startsWith("/") ||
              /^[a-zA-Z]:[\\/]/u.test(fileName) ||
              fileName.split("/").includes("..")
            ) {
              throw new OfficialPluginPackageError("zip entry escapes the extraction root");
            }
            const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (unixMode === 0o120000) {
              throw new OfficialPluginPackageError("zip symbolic link entries are not allowed");
            }
            const segments = fileName.split("/").filter(Boolean);
            if (segments.length === 0) {
              zipFile.readEntry();
              return;
            }
            topLevels.add(segments[0]!);
            const target = resolve(stagingRoot, ...segments);
            if (target !== stagingRoot && !target.startsWith(stagingRoot + sep)) {
              throw new OfficialPluginPackageError("zip entry escapes the extraction root");
            }
            if (fileName.endsWith("/")) {
              await mkdir(target, { recursive: true });
              zipFile.readEntry();
              return;
            }
            if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
              throw new OfficialPluginPackageError("zip entry exceeds the single-file size limit");
            }
            totalBytes += entry.uncompressedSize;
            if (totalBytes > ZIP_EXTRACT_MAX_BYTES) {
              throw new OfficialPluginPackageError("zip exceeds the total extraction size limit");
            }
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zipFile.openReadStream(entry, (error, result) =>
                error || !result ? rej(error) : res(result),
              ),
            );
            await mkdir(dirname(target), { recursive: true });
            await pipeline(stream, createWriteStream(target));
            zipFile.readEntry();
          } catch (error) {
            reject(error);
          }
        })();
      });
      zipFile.readEntry();
    });
    if (topLevels.size !== 1) {
      throw new OfficialPluginPackageError(
        "official plugin zip must contain exactly one top-level directory",
      );
    }
    return { pluginDir: join(stagingRoot, topLevels.values().next().value as string), stagingRoot };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupStagingRoot(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
}
