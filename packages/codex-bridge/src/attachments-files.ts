import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import {
  PROTOCOL_V4_LIMITS as LIMITS,
  v4AttachmentBeginParamsSchema,
  type AttachmentRef,
  type V4AttachmentBeginParams,
} from "@zcode/shared/zcode-protocol-v4";
import { attachmentFault, type ResolvedAttachment } from "./attachments-types.js";

const PREFIX = "zcode-attachment://";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const metadataSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string(),
    id: z.string().regex(idPattern),
    upload: v4AttachmentBeginParamsSchema,
    derived: z.literal(true).optional(),
  })
  .strict();

/** Reject symlinked directories instead of following workspace-controlled storage redirects. */
async function directory(path: string, boundary: string): Promise<void> {
  const parent = dirname(path);
  if (path !== boundary && parent !== path) await directory(parent, boundary);
  try {
    // 仅信任 host 给定边界的祖先（macOS /var 等可以是系统链接）；存储子目录不得是链接。
    await mkdir(path, { mode: 0o700, recursive: path === boundary });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw attachmentFault("unsafeStoragePath");
}

export async function openAttachmentFile(path: string, maxBytes: number): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw attachmentFault("unsafeStoragePath");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino)
      throw attachmentFault("unsafeStoragePath");
    if (info.size > maxBytes) throw attachmentFault("previewTooLarge");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readBounded(file: FileHandle, maxBytes: number): Promise<Buffer> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!result.bytesRead) return bytes.subarray(0, offset);
    offset += result.bytesRead;
  }
  throw attachmentFault("previewTooLarge");
}

function imageDigest(
  url: string,
): { checksum: string; bytes: number; data: Buffer; mime: string; fileName: string } | undefined {
  const maxEncoded = 4 * Math.ceil(LIMITS.attachmentMaxBytes / 3);
  if (typeof url !== "string" || url.length > maxEncoded + 256) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0 || comma > 255) return undefined;
  const header = /^data:image\/(png|jpeg|webp|gif);base64$/i.exec(url.slice(0, comma));
  if (!header) return undefined;
  const kind = header[1]!.toLowerCase();
  const encoded = url.slice(comma + 1);
  if (!encoded.length || encoded.length > maxEncoded || encoded.length % 4) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  // Buffer.from 会容忍非 base64 字符及非规范 padding；先限长，再往返校验，拒绝歧义编码。
  if (
    !bytes.length ||
    bytes.length > LIMITS.attachmentMaxBytes ||
    bytes.toString("base64") !== encoded
  )
    return undefined;
  return {
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length,
    data: bytes,
    mime: `image/${kind}`,
    fileName: `native-image.${kind}`,
  };
}

function isMissingOrUnowned(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "fault.attachment.refNotAuthorized";
}

export class AttachmentFiles {
  readonly root: string;
  private readonly workspace: string;
  private readonly boundary: string;
  constructor(cwd: string, root?: string) {
    this.root = resolve(cwd, root ?? ".zcode/codex-bridge/attachments");
    if (this.root === parse(this.root).root || this.root === resolve(cwd))
      throw attachmentFault("unsafeStoragePath");
    const within = relative(resolve(cwd), this.root);
    this.boundary =
      within !== ".." &&
      !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(within)
        ? resolve(cwd)
        : dirname(this.root);
    this.workspace = createHash("sha256").update(resolve(cwd)).digest("hex");
  }

  async prepare(): Promise<void> {
    await directory(join(this.root, "staging"), this.boundary);
    await directory(join(this.root, "objects"), this.boundary);
  }

  async stage(): Promise<{ path: string; file: FileHandle }> {
    await this.prepare();
    const path = join(this.root, "staging", `${randomUUID()}.part`);
    return { path, file: await open(path, "wx+", 0o600) };
  }

  async discard(path: string): Promise<void> {
    await this.prepare();
    if (dirname(path) !== join(this.root, "staging")) throw attachmentFault("unsafeStoragePath");
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async publish(path: string, upload: V4AttachmentBeginParams, derived = false): Promise<string> {
    await this.prepare();
    const id = randomUUID();
    const blob = join(this.root, "objects", `${id}.data`);
    const manifest = join(this.root, "objects", `${id}.json`);
    const temporary = join(this.root, "staging", `${id}.json`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            workspace: this.workspace,
            id,
            upload,
            ...(derived ? { derived: true } : {}),
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(path, blob);
      await rename(temporary, manifest);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      await unlink(blob).catch(() => {});
      throw error;
    }
    return `${PREFIX}${id}`;
  }

  async findNativeAttachment(path: string, sessionId: string): Promise<AttachmentRef | undefined> {
    if (typeof path !== "string" || !isAbsolute(path) || !sessionId) return undefined;
    const id = basename(path, ".data");
    // 原生历史的 path 也不能直接读取：只接受本 store 生成的精确路径，再按 ref 验证归属。
    // 不 normalize/realpath 调用方输入，避免把路径穿越、链接别名或其他目录误认成已上传附件。
    if (!idPattern.test(id) || path !== join(this.root, "objects", `${id}.data`)) return undefined;
    try {
      const resolved = await this.resolve(`${PREFIX}${id}`, sessionId);
      return {
        ref: resolved.ref,
        fileName: resolved.fileName,
        mime: resolved.mime,
        bytes: resolved.bytes,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "fault.attachment.refNotAuthorized") return undefined;
      throw error;
    }
  }

  async findNativeImageAttachment(
    url: string,
    sessionId: string,
  ): Promise<AttachmentRef | undefined> {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 1024) return undefined;
    const digest = imageDigest(url);
    if (!digest) return undefined;
    await this.prepare();
    const candidates: string[] = [];
    let entries = 0;
    // 原生历史会把 localImage 改写为 data URL，不能依赖路径或内存缓存恢复预览。
    // 只扫描本 store 的有界 manifest；先验证归属，再校验匹配 blob，URL 永不用于文件/网络 IO。
    for await (const entry of await opendir(join(this.root, "objects"))) {
      if (++entries > 4096) throw attachmentFault("lookupLimit");
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!idPattern.test(id)) continue;
      try {
        const { upload } = await this.metadata(id, sessionId);
        if (
          upload.mime.toLowerCase().startsWith("image/") &&
          upload.checksum === digest.checksum &&
          upload.totalBytes === digest.bytes
        )
          candidates.push(id);
      } catch (error) {
        if (!isMissingOrUnowned(error)) throw error;
      }
    }
    for (const id of candidates.sort()) {
      try {
        const found = await this.resolve(`${PREFIX}${id}`, sessionId);
        // resolve 再读 manifest：期间发生替换时也不能返回另一个内容的 ref。
        if (
          found.checksum === digest.checksum &&
          found.bytes === digest.bytes &&
          found.mime.startsWith("image/")
        )
          return { ref: found.ref, fileName: found.fileName, mime: found.mime, bytes: found.bytes };
      } catch (error) {
        if (!isMissingOrUnowned(error)) throw error;
      }
    }
    if (entries + 2 > 4096) throw attachmentFault("lookupLimit");
    // native resize/fork 后原 SHA/ref 不再对应；仅从权威原生行导入副本，不跨 session 借用 ref。
    // 这不是客户端 URL 上传入口；创建副本不授予预览权限，main 仍需按当前行授权。
    const upload = v4AttachmentBeginParamsSchema.parse({
      connectionId: "native-history",
      uploadId: randomUUID(),
      sessionId,
      fileName: digest.fileName,
      mime: digest.mime,
      totalBytes: digest.bytes,
      totalChunks: Math.ceil(digest.bytes / LIMITS.attachmentChunkMaxBytes),
      checksum: digest.checksum,
    });
    const staged = await this.stage();
    try {
      try {
        for (let offset = 0; offset < digest.bytes; offset += LIMITS.attachmentChunkMaxBytes)
          await staged.file.writeFile(
            digest.data.subarray(offset, offset + LIMITS.attachmentChunkMaxBytes),
          );
        await staged.file.sync();
      } finally {
        await staged.file.close();
      }
      const ref = await this.publish(staged.path, upload, true);
      return { ref, fileName: digest.fileName, mime: digest.mime, bytes: digest.bytes };
    } catch (error) {
      await this.discard(staged.path);
      throw error;
    }
  }

  private async metadata(id: string, sessionId: string): Promise<z.infer<typeof metadataSchema>> {
    const manifest = await openAttachmentFile(join(this.root, "objects", `${id}.json`), 16 * 1024);
    let metadata: z.infer<typeof metadataSchema>;
    try {
      metadata = metadataSchema.parse(
        JSON.parse((await readBounded(manifest, 16 * 1024)).toString("utf8")),
      );
    } finally {
      await manifest.close();
    }
    if (
      metadata.id !== id ||
      metadata.workspace !== this.workspace ||
      metadata.upload.sessionId !== sessionId
    )
      throw attachmentFault("refNotAuthorized");
    return metadata;
  }

  async resolve(ref: string, sessionId: string, metadataOnly = false): Promise<ResolvedAttachment> {
    if (
      typeof ref !== "string" ||
      !ref.startsWith(PREFIX) ||
      !idPattern.test(ref.slice(PREFIX.length))
    ) {
      throw attachmentFault("refNotAuthorized");
    }
    const id = ref.slice(PREFIX.length);
    await this.prepare();
    const metadata = await this.metadata(id, sessionId);
    const path = join(this.root, "objects", `${id}.data`);
    const file = await openAttachmentFile(
      path,
      metadataOnly ? LIMITS.attachmentStatMaxBytes : LIMITS.attachmentMaxBytes,
    );
    let totalBytes = metadata.upload.totalBytes;
    try {
      // stat 必须只查询元信息；完整性校验归读取/发送，不能让选择阶段搬运整个附件。
      if (metadataOnly) totalBytes = (await file.stat()).size;
      else {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(LIMITS.attachmentChunkMaxBytes);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          if (offset > metadata.upload.totalBytes) throw attachmentFault("lengthMismatch");
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (offset !== metadata.upload.totalBytes) throw attachmentFault("lengthMismatch");
        if (`sha256:${hash.digest("hex")}` !== metadata.upload.checksum)
          throw attachmentFault("checksumMismatch");
      }
    } finally {
      await file.close();
    }
    return {
      ref,
      path,
      sessionId,
      fileName: metadata.upload.fileName,
      mime: metadata.upload.mime.toLowerCase(),
      bytes: totalBytes,
      checksum: metadata.upload.checksum,
    };
  }
}
