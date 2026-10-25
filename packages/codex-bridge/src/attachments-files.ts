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
} from "@codez/shared/codez-protocol-v4";
import { attachmentFault, type ResolvedAttachment } from "./attachments-types.js";

const PREFIX = "codez-attachment://";
const DIGEST_CACHE_LIMIT = 64;
const IMAGE_LOOKUP_CACHE_LIMIT = 256;
/** 已验证 blob 身份的 LRU 上限；淘汰只影响性能，下次读取会重新完整校验。 */
const VERIFIED_BLOB_CACHE_LIMIT = 256;
/**
 * 命中缓存时复验内容用的头尾采样长度（各 64 KiB）。
 * 原因：Linux VFS 时间戳来自粗粒度时钟（本机 overlayfs 实测 4ms 一格），同一格内的
 * 等长原地改写会得到完全相同的 (dev, ino, size, mtimeMs, ctimeMs)，仅靠身份字段无法
 * 区分「未变」与「刚被改写」。头尾采样把命中路径的复验成本限制在 128 KiB（分页读取本身
 * 就是 512 KiB 级），并让 ≤64 KiB 的 blob 在命中时等价于全内容复验。
 */
const VERIFIED_BLOB_SAMPLE_BYTES = 64 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ImageDigestResult = {
  checksum: string;
  bytes: number;
  data: Buffer;
  mime: string;
  fileName: string;
};
const imageDigestCache = new Map<string, ImageDigestResult>();
const metadataSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string(),
    id: z.string().regex(idPattern),
    upload: v4AttachmentBeginParamsSchema,
    derived: z.literal(true).optional(),
  })
  .strict();
type AttachmentMetadata = z.infer<typeof metadataSchema>;

/** 打开句柄后 fstat 得到的文件身份；任一字段变化都视为另一个 blob，必须重新完整校验。 */
type BlobIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

/** 一条已通过完整 SHA-256 + totalBytes 校验的记录，绑定 workspace/id/文件身份/checksum。 */
type VerifiedBlob = BlobIdentity & {
  workspace: string;
  id: string;
  checksum: string;
  totalBytes: number;
  sample: string;
};

function blobKey(workspace: string, id: string, identity: BlobIdentity, checksum: string): string {
  return [
    workspace,
    id,
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeMs,
    identity.ctimeMs,
    checksum,
  ].join("\u0000");
}

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

export async function openAttachmentFile(
  path: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw attachmentFault("unsafeStoragePath");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino)
      throw attachmentFault("unsafeStoragePath");
    if (info.size > maxBytes) throw attachmentFault("previewTooLarge");
    // 磁盘长度必须等于 manifest 声明长度；缓存只能跳过摘要计算，不能跳过这条校验。
    if (expectedBytes !== undefined && info.size !== expectedBytes)
      throw attachmentFault("lengthMismatch");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** 精确填满 buffer 的定位读取；短读只可能是并发替换/截断，必须 fail-closed。 */
async function readExact(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let received = 0;
  while (received < bytes.length) {
    const { bytesRead } = await file.read(
      bytes,
      received,
      bytes.length - received,
      position + received,
    );
    if (!bytesRead) throw attachmentFault("lengthMismatch");
    received += bytesRead;
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

function imageDigest(url: string): ImageDigestResult | undefined {
  const maxEncoded = 4 * Math.ceil(LIMITS.attachmentMaxBytes / 3);
  if (typeof url !== "string" || url.length > maxEncoded + 256) return undefined;
  const cached = imageDigestCache.get(url);
  if (cached) {
    imageDigestCache.delete(url);
    imageDigestCache.set(url, cached);
    return cached;
  }
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
  const result: ImageDigestResult = {
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length,
    data: bytes,
    mime: `image/${kind}`,
    fileName: `native-image.${kind}`,
  };
  imageDigestCache.set(url, result);
  if (imageDigestCache.size > DIGEST_CACHE_LIMIT) {
    imageDigestCache.delete(imageDigestCache.keys().next().value!);
  }
  return result;
}

function isMissingOrUnowned(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "fault.attachment.refNotAuthorized";
}

export class AttachmentFiles {
  readonly root: string;
  private readonly workspace: string;
  private readonly boundary: string;
  /** (sessionId, checksum, bytes) → 已校验的候选 id（读取时仍通过 resolve 校验磁盘与完整性）。 */
  private readonly imageLookupCache = new Map<string, string>();
  /** blobKey → 已通过完整校验的记录；分页读取命中后只读请求区间，不再从头重算 SHA-256。 */
  private readonly verifiedBlobCache = new Map<string, VerifiedBlob>();
  /** blobKey → 进行中的完整校验；同一文件身份的并发首检合并为一次（归属仍各自校验）。 */
  private readonly verifyingBlobs = new Map<string, Promise<void>>();
  private verifiedCount = 0;
  constructor(cwd: string, root?: string) {
    this.root = resolve(cwd, root ?? ".codez/codex-bridge/attachments");
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

  /** 完整 SHA-256 校验次数；诊断与测试据此断言分页读取没有重复整文件校验。 */
  get integrityVerificationCount(): number {
    return this.verifiedCount;
  }

  /** AttachmentStore.close() 调用：进程内缓存不得跨 store 生命周期存活。 */
  clearCaches(): void {
    this.verifiedBlobCache.clear();
    this.verifyingBlobs.clear();
    this.imageLookupCache.clear();
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
      // publish 之后该 id 的磁盘内容才是权威版本；丢弃同名 id 的任何历史校验记录。
      this.forgetBlob(id);
      // 新上传可能提供字典序更小的 id 或影响对象目录；使当前 session 的查找缓存失效，
      // 让首次 findNativeImageAttachment 通过一次受预算限制的扫描确立权威候选，后续快照直接复用。
      if (upload.mime.toLowerCase().startsWith("image/")) {
        this.imageLookupCache.delete(
          `${upload.sessionId}\u0000${upload.checksum}\u0000${upload.totalBytes}`,
        );
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      await unlink(blob).catch(() => {});
      throw error;
    }
    return `${PREFIX}${id}`;
  }

  private rememberImageCandidate(cacheKey: string, id: string): void {
    this.imageLookupCache.delete(cacheKey);
    this.imageLookupCache.set(cacheKey, id);
    if (this.imageLookupCache.size > IMAGE_LOOKUP_CACHE_LIMIT) {
      this.imageLookupCache.delete(this.imageLookupCache.keys().next().value!);
    }
  }

  async findNativeAttachment(
    path: string,
    sessionId: string,
    inlineChecksum?: string,
  ): Promise<AttachmentRef | undefined> {
    if (typeof path !== "string" || !isAbsolute(path) || !sessionId) return undefined;
    const id = basename(path, ".data");
    // 原生历史的 path 也不能直接读取：只接受本 store 生成的精确路径，再按 ref 验证归属。
    // 不 normalize/realpath 调用方输入，避免把路径穿越、链接别名或其他目录误认成已上传附件。
    if (!idPattern.test(id) || path !== join(this.root, "objects", `${id}.data`)) return undefined;
    try {
      const resolved = await this.resolve(`${PREFIX}${id}`, sessionId);
      if (inlineChecksum !== undefined && resolved.checksum !== inlineChecksum) return undefined;
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
    const cacheKey = `${sessionId}\u0000${digest.checksum}\u0000${digest.bytes}`;
    const cachedId = this.imageLookupCache.get(cacheKey);
    if (cachedId) {
      try {
        const found = await this.resolve(`${PREFIX}${cachedId}`, sessionId);
        if (
          found.checksum === digest.checksum &&
          found.bytes === digest.bytes &&
          found.mime.startsWith("image/")
        ) {
          this.rememberImageCandidate(cacheKey, cachedId);
          return { ref: found.ref, fileName: found.fileName, mime: found.mime, bytes: found.bytes };
        }
      } catch (error) {
        this.imageLookupCache.delete(cacheKey);
        if (!isMissingOrUnowned(error)) throw error;
      }
    }
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
        ) {
          this.rememberImageCandidate(cacheKey, id);
          return { ref: found.ref, fileName: found.fileName, mime: found.mime, bytes: found.bytes };
        }
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
      const derivedId = ref.slice(PREFIX.length);
      this.rememberImageCandidate(cacheKey, derivedId);
      return { ref, fileName: digest.fileName, mime: digest.mime, bytes: digest.bytes };
    } catch (error) {
      await this.discard(staged.path);
      throw error;
    }
  }

  private async metadata(id: string, sessionId: string): Promise<AttachmentMetadata> {
    const manifest = await openAttachmentFile(join(this.root, "objects", `${id}.json`), 16 * 1024);
    let metadata: AttachmentMetadata;
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

  /** ref 形态校验；不 normalize，不接受任何非本 store 生成的不透明 id。 */
  private attachmentId(ref: string): string {
    if (
      typeof ref !== "string" ||
      !ref.startsWith(PREFIX) ||
      !idPattern.test(ref.slice(PREFIX.length))
    )
      throw attachmentFault("refNotAuthorized");
    return ref.slice(PREFIX.length);
  }

  private blobPath(id: string): string {
    return join(this.root, "objects", `${id}.data`);
  }

  private resolved(
    ref: string,
    path: string,
    sessionId: string,
    metadata: AttachmentMetadata,
    bytes: number,
  ): ResolvedAttachment {
    return {
      ref,
      path,
      sessionId,
      fileName: metadata.upload.fileName,
      mime: metadata.upload.mime.toLowerCase(),
      bytes,
      checksum: metadata.upload.checksum,
    };
  }

  async resolve(ref: string, sessionId: string, metadataOnly = false): Promise<ResolvedAttachment> {
    const id = this.attachmentId(ref);
    await this.prepare();
    // 归属校验每次都做：缓存只跳过摘要计算，绝不跳过 (workspace, id, sessionId) 所有权。
    const metadata = await this.metadata(id, sessionId);
    const path = this.blobPath(id);
    if (metadataOnly) {
      // stat 必须只查询元信息；完整性校验归读取/发送，不能让选择阶段搬运整个附件。
      const file = await openAttachmentFile(path, LIMITS.attachmentStatMaxBytes);
      try {
        return this.resolved(ref, path, sessionId, metadata, (await file.stat()).size);
      } finally {
        await file.close();
      }
    }
    const file = await this.openVerifiedBlob(id, metadata, LIMITS.attachmentMaxBytes);
    try {
      return this.resolved(ref, path, sessionId, metadata, metadata.upload.totalBytes);
    } finally {
      await file.close();
    }
  }

  /**
   * 分页预览读取 [offset, offset + limit)：归属、文件身份与完整性每次都校验，
   * 但完整 SHA-256 只在身份未命中缓存（或采样复验不一致）时执行一次，
   * 之后每页只搬运请求区间。校验与切片共用同一个句柄，避免两者之间被替换。
   */
  async readSlice(
    ref: string,
    sessionId: string,
    offset: number,
    limit: number,
  ): Promise<{ resolved: ResolvedAttachment; bytes: Buffer }> {
    // 原因：offset/limit 直接用于 Buffer.alloc 与定位读取；非整数或负值先 fail-closed，
    // 上限由 blob 自身长度收敛，不在这里复制协议分页上限。
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0)
      throw attachmentFault("previewRangeInvalid");
    const id = this.attachmentId(ref);
    await this.prepare();
    const metadata = await this.metadata(id, sessionId);
    const path = this.blobPath(id);
    const file = await this.openVerifiedBlob(id, metadata, LIMITS.attachmentPreviewMaxBytes);
    try {
      const resolved = this.resolved(ref, path, sessionId, metadata, metadata.upload.totalBytes);
      if (offset > resolved.bytes) throw attachmentFault("previewRangeInvalid");
      const bytes = Buffer.alloc(Math.min(limit, resolved.bytes - offset));
      await readExact(file, bytes, offset);
      return { resolved, bytes };
    } finally {
      await file.close();
    }
  }

  /**
   * 打开归属已校验的 blob，并保证它通过了一次完整 SHA-256 + totalBytes 校验。
   * 命中缓存时只做有界头尾采样复验；调用方负责关闭返回的句柄。
   */
  private async openVerifiedBlob(
    id: string,
    metadata: AttachmentMetadata,
    maxBytes: number,
  ): Promise<FileHandle> {
    // 符号链接、硬链接、dev/ino 漂移与声明长度都在 openAttachmentFile 内 fail-closed。
    const file = await openAttachmentFile(this.blobPath(id), maxBytes, metadata.upload.totalBytes);
    try {
      const info = await file.stat();
      const identity: BlobIdentity = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
      const key = blobKey(this.workspace, id, identity, metadata.upload.checksum);
      const cached = this.verifiedBlobCache.get(key);
      if (cached) {
        if ((await this.sampleDigest(file, info.size)) === cached.sample) {
          this.verifiedBlobCache.delete(key);
          this.verifiedBlobCache.set(key, cached);
          return file;
        }
        // 采样不一致：内容已改写但身份字段恰好落在同一时间戳刻度。丢弃记录并自己重新
        // 完整校验；这里刻意不加入其他请求的 in-flight 校验，因为它可能读到改写前的内容。
        this.forgetBlob(id);
        await this.verifyAndRemember(file, id, metadata, key, identity, false);
        return file;
      }
      const pending = this.verifyingBlobs.get(key);
      if (pending) {
        // 同一文件身份的并发首检合并为一次；归属与行授权仍由每个请求各自完成。
        await pending;
        return file;
      }
      await this.verifyAndRemember(file, id, metadata, key, identity, true);
      return file;
    } catch (error) {
      // 校验失败必须 fail-closed，并清除该 id 的记录，避免后续请求命中已被推翻的结论。
      this.forgetBlob(id);
      await file.close();
      throw error;
    }
  }

  /** 执行一次完整校验并写入缓存；shareInFlight 决定是否允许同身份请求合并到本次校验。 */
  private async verifyAndRemember(
    file: FileHandle,
    id: string,
    metadata: AttachmentMetadata,
    key: string,
    identity: BlobIdentity,
    shareInFlight: boolean,
  ): Promise<void> {
    const verification = this.verifyBlob(file, metadata);
    if (shareInFlight) this.verifyingBlobs.set(key, verification);
    try {
      await verification;
      this.rememberVerifiedBlob(key, {
        ...identity,
        workspace: this.workspace,
        id,
        checksum: metadata.upload.checksum,
        totalBytes: metadata.upload.totalBytes,
        sample: await this.sampleDigest(file, identity.size),
      });
    } finally {
      if (shareInFlight) this.verifyingBlobs.delete(key);
    }
  }

  /** 流式读取整个 blob 校验 totalBytes 与 SHA-256；每次完整校验都累加计数供诊断与测试断言。 */
  private async verifyBlob(file: FileHandle, metadata: AttachmentMetadata): Promise<void> {
    this.verifiedCount += 1;
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

  /** 头尾各 ≤64 KiB 的有界采样摘要；size ≤64 KiB 时等价于全内容摘要。 */
  private async sampleDigest(file: FileHandle, size: number): Promise<string> {
    const length = Math.min(size, VERIFIED_BLOB_SAMPLE_BYTES);
    const head = Buffer.alloc(length);
    await readExact(file, head, 0);
    const tailOffset = Math.max(0, size - length);
    const tail = Buffer.alloc(length);
    if (tailOffset) await readExact(file, tail, tailOffset);
    else tail.set(head);
    return createHash("sha256").update(head).update(tail).digest("hex");
  }

  private rememberVerifiedBlob(key: string, record: VerifiedBlob): void {
    this.verifiedBlobCache.delete(key);
    this.verifiedBlobCache.set(key, record);
    while (this.verifiedBlobCache.size > VERIFIED_BLOB_CACHE_LIMIT)
      this.verifiedBlobCache.delete(this.verifiedBlobCache.keys().next().value!);
  }

  /** 丢弃某个 id 的全部已验证记录：publish、校验失败与 close 都必须让缓存失效。 */
  private forgetBlob(id: string): void {
    for (const [key, record] of this.verifiedBlobCache)
      if (record.id === id) this.verifiedBlobCache.delete(key);
  }
}
