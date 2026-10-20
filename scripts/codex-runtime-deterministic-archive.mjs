import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BLOCK = 512;
const END = Buffer.alloc(BLOCK * 2);

function octal(header, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length >= width) throw new Error("Codex archive header field overflow");
  header.write(text, offset, width - 1, "ascii");
}

function pathFields(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  const parts = name.split("/");
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join("/");
    const suffix = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100)
      return { name: suffix, prefix };
  }
  throw new Error(`Codex archive path is too long: ${name}`);
}

function headerFor(name, size, mode, directory) {
  const header = Buffer.alloc(BLOCK);
  const fields = pathFields(name);
  header.write(fields.name, 0, 100, "utf8");
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(directory ? "5" : "0", 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(fields.prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  octal(header, 148, 7, checksum);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function* archiveEntries(source, name = "") {
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    if (name) yield headerFor(`${name}/`, 0, 0o755, true);
    const children = (await readdir(source)).sort();
    for (const child of children)
      yield* archiveEntries(join(source, child), name ? posix.join(name, child) : child);
    return;
  }
  // 原生发行包和远程工具生产者只允许普通文件/目录；拒绝符号链接及特殊设备，
  // 避免把一个未经清单验证的外部路径塞入可执行组件。
  if (!stat.isFile()) throw new Error(`Unsupported Codex archive entry: ${name}`);
  const mode = stat.mode & 0o111 ? 0o755 : 0o644;
  yield headerFor(name, stat.size, mode, false);
  for await (const chunk of createReadStream(source)) yield chunk;
  const padding = (BLOCK - (stat.size % BLOCK)) % BLOCK;
  if (padding) yield Buffer.alloc(padding);
}

/**
 * Component SHA is a deployment identity. Repacking the same bytes must not
 * change it because a temp directory had a different mtime, uid or traversal order.
 * Stream the tar so the ~250 MiB native package is never buffered in one process.
 */
export async function createDeterministicCodexTarGz({ archivePath, directory }) {
  await mkdir(dirname(archivePath), { recursive: true });
  async function* contents() {
    yield* archiveEntries(directory);
    yield END;
  }
  await pipeline(
    Readable.from(contents()),
    createGzip({ level: 9 }),
    createWriteStream(archivePath),
  );
}
