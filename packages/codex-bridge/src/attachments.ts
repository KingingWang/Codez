import {
  PROTOCOL_V4_LIMITS as LIMITS,
  V4_METHODS,
  attachmentRefSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentAbortParamsSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  type AttachmentRef,
} from "@codez/shared/codez-protocol-v4";
import {
  formatNativeFileReference,
  formatNativeInlineFileReference,
} from "./native-file-reference.js";
import type { CodexUserInput } from "./codex-types.js";
import { AttachmentFiles, openAttachmentFile } from "./attachments-files.js";
import { AttachmentUploads } from "./attachments-upload.js";
import {
  attachmentFault,
  type AttachmentReadAuthorization,
  type AttachmentStoreOptions,
  type ResolvedAttachment,
} from "./attachments-types.js";
export type {
  AttachmentStoreOptions,
  AttachmentReadAuthorization,
  ResolvedAttachment,
} from "./attachments-types.js";

const MAX_OPERATIONS = 64;
const MAX_TEXT_BYTES = 1024 * 1024;
const INLINE_TEXT_MAX_CHARS = 64 * 1024;
const INLINE_TEXT_MAX_FILE_BYTES = 256 * 1024;

function isTextFile(mime: string, filename: string): boolean {
  return (
    mime.startsWith("text/") ||
    /^(application\/(json|xml|javascript|x-yaml))$/u.test(mime) ||
    (mime === "application/octet-stream" &&
      /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(
        filename,
      ))
  );
}

function isKnownBinaryFile(filename: string): boolean {
  return /\.(7z|avi|db|docx?|exe|gif|gz|jpe?g|mp[34]|pdf|png|rar|sqlite|tar|wasm|webp|woff2?|xlsx?|zip)$/iu.test(
    filename,
  );
}

function hasBinaryBytes(buffer: Buffer): boolean {
  // 原因：ZIP 的 PK 头是合法 UTF-8/ASCII；错误的 text/plain MIME 不能据此将压缩包当正文。
  if (
    (buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      ((buffer[2] === 3 && buffer[3] === 4) ||
        (buffer[2] === 5 && buffer[3] === 6) ||
        (buffer[2] === 7 && buffer[3] === 8))) ||
    buffer.subarray(0, 4).toString("ascii") === "%PDF" ||
    (buffer[0] === 0x1f && buffer[1] === 0x8b)
  )
    return true;
  return buffer.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)));
}

export class AttachmentStore {
  private readonly files: AttachmentFiles;
  private readonly uploads: AttachmentUploads;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private closing?: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: AttachmentStoreOptions) {
    this.files = new AttachmentFiles(options.cwd, options.root);
    this.uploads = new AttachmentUploads(this.files, options.now ?? Date.now);
    this.timer = setInterval(() => {
      if (!this.closed && !this.queued)
        void this.serial(() => this.uploads.prune()).catch(() => {});
    }, 30_000);
    this.timer.unref();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(attachmentFault("closed"));
    if (this.queued >= MAX_OPERATIONS) return Promise.reject(attachmentFault("operationLimit"));
    this.queued++;
    const result = this.tail.then(operation);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.queued--;
      });
    return result;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    // schema 的 base64 扫描前先限制编码长度，防止恶意超大字符串占用同步 CPU。
    if (method === V4_METHODS.attachmentChunk && params && typeof params === "object") {
      const value = (params as Record<string, unknown>).dataBase64;
      if (
        typeof value === "string" &&
        value.length > 4 * Math.ceil(LIMITS.attachmentChunkMaxBytes / 3)
      )
        throw attachmentFault("chunkTooLarge");
    }
    switch (method) {
      case V4_METHODS.attachmentBegin: {
        const value = v4AttachmentBeginParamsSchema.parse(params);
        if (value.sessionId.length > 1024 || value.connectionId.length > 1024)
          throw attachmentFault("scopeLimit");
        return this.serial(async () => {
          await this.uploads.prune();
          return this.uploads.begin(value);
        });
      }
      case V4_METHODS.attachmentChunk: {
        const value = v4AttachmentChunkParamsSchema.parse(params);
        return this.serial(async () => {
          await this.uploads.prune();
          return this.uploads.chunk(value);
        });
      }
      case V4_METHODS.attachmentCommit: {
        const value = v4AttachmentCommitParamsSchema.parse(params);
        return this.serial(async () => {
          await this.uploads.prune();
          return this.uploads.commit(value);
        });
      }
      case V4_METHODS.attachmentAbort: {
        const value = v4AttachmentAbortParamsSchema.parse(params);
        return this.serial(async () => {
          await this.uploads.prune();
          return this.uploads.abort(value);
        });
      }
      case V4_METHODS.attachmentRead:
      case V4_METHODS.conversationAttachmentRead: {
        const value =
          method === V4_METHODS.attachmentRead
            ? v4AttachmentReadParamsSchema.parse(params)
            : v4ConversationAttachmentReadParamsSchema.parse(params);
        return this.serial(async () => {
          const resolved = await this.authorized({ method, ...value });
          if (
            method === V4_METHODS.attachmentRead &&
            !/^(image\/|video\/|application\/pdf$)/.test(resolved.mime)
          )
            throw attachmentFault("previewNotMedia");
          if (value.offset > resolved.bytes) throw attachmentFault("previewRangeInvalid");
          const file = await openAttachmentFile(resolved.path, LIMITS.attachmentPreviewMaxBytes);
          const bytes = Buffer.alloc(Math.min(value.limit, resolved.bytes - value.offset));
          try {
            let received = 0;
            while (received < bytes.length) {
              const { bytesRead } = await file.read(
                bytes,
                received,
                bytes.length - received,
                value.offset + received,
              );
              if (!bytesRead) throw attachmentFault("lengthMismatch");
              received += bytesRead;
            }
          } finally {
            await file.close();
          }
          const end = value.offset + bytes.length;
          const result = {
            dataBase64: bytes.toString("base64"),
            mediaType: resolved.mime,
            totalBytes: resolved.bytes,
            nextOffset: end < resolved.bytes ? end : null,
          };
          return method === V4_METHODS.attachmentRead
            ? v4AttachmentReadResultSchema.parse(result)
            : v4ConversationAttachmentReadResultSchema.parse(result);
        });
      }
      case V4_METHODS.conversationAttachmentStat: {
        const value = v4ConversationAttachmentStatParamsSchema.parse(params);
        return this.serial(async () => {
          const resolved = await this.authorized({ method, ...value });
          return v4ConversationAttachmentStatResultSchema.parse({
            mediaType: resolved.mime,
            totalBytes: resolved.bytes,
          });
        });
      }
      default:
        throw Object.assign(new Error("Unsupported attachment method"), { code: -32601 });
    }
  }

  /** Ownership only, NOT row authorization. Main must gate previews against authoritative rows. */
  resolve(ref: string, sessionId: string): Promise<ResolvedAttachment> {
    return this.serial(() => this.files.resolve(ref, sessionId));
  }

  /** Restore persisted metadata from a native path; main still owns projection/row authorization.
   * No match for unrelated/missing/cross-scope files; corrupt or unsafe storage rejects.
   */
  findNativeAttachment(
    path: string,
    sessionId: string,
    inlineChecksum?: string,
  ): Promise<AttachmentRef | undefined> {
    return this.serial(() => this.files.findNativeAttachment(path, sessionId, inlineChecksum));
  }

  /** Host-only: recover/import a bounded authoritative native userMessage image, never client URLs.
   * Unmatched images persist as session-owned derived previews; main must still authorize the row.
   */
  findNativeImageAttachment(url: string, sessionId: string): Promise<AttachmentRef | undefined> {
    return this.serial(() => this.files.findNativeImageAttachment(url, sessionId));
  }

  async toNativeInput(
    refs: readonly AttachmentRef[] | undefined,
    sessionId: string,
  ): Promise<CodexUserInput[]> {
    if (refs && (!Array.isArray(refs) || refs.length > 64)) throw attachmentFault("inputLimit");
    const inputs = (refs ?? []).map((ref) => attachmentRefSchema.parse(ref));
    return this.serial(async () => {
      const result: CodexUserInput[] = [];
      let textBytes = 0;
      let totalBytes = 0;
      for (const input of inputs) {
        const resolved = await this.files.resolve(input.ref, sessionId);
        totalBytes += resolved.bytes;
        if (totalBytes > LIMITS.attachmentUploadMaxStagedBytes) throw attachmentFault("inputLimit");
        if (resolved.mime.startsWith("image/"))
          result.push({ type: "localImage", path: resolved.path });
        else {
          let inline: string | undefined;
          if (
            input.sourceKind !== "clipboard-text" &&
            resolved.bytes > 0 &&
            isTextFile(resolved.mime, resolved.fileName) &&
            !isKnownBinaryFile(resolved.fileName) &&
            resolved.bytes <= INLINE_TEXT_MAX_FILE_BYTES &&
            textBytes + resolved.bytes <= MAX_TEXT_BYTES
          ) {
            const file = await openAttachmentFile(resolved.path, INLINE_TEXT_MAX_FILE_BYTES);
            try {
              const buffer = Buffer.alloc(resolved.bytes);
              let offset = 0;
              while (offset < buffer.length) {
                const { bytesRead } = await file.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  offset,
                );
                if (!bytesRead) throw attachmentFault("lengthMismatch");
                offset += bytesRead;
              }
              try {
                if (!hasBinaryBytes(buffer)) {
                  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                    buffer,
                  );
                  if (text.length <= INLINE_TEXT_MAX_CHARS) inline = text;
                }
              } catch {
                // 原因：文本 MIME 也可能携带损坏/二进制字节；不能把替换字符当原文送进上下文。
                // 保留已校验的完整 blob，让 Agent 自己按需读取。
              }
            } finally {
              await file.close();
            }
          }
          const attachment = {
            ref: resolved.ref,
            fileName: resolved.fileName,
            mime: resolved.mime,
            bytes: resolved.bytes,
            ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
          };
          const inlineInput =
            inline === undefined
              ? undefined
              : formatNativeInlineFileReference({
                  attachment,
                  path: resolved.path,
                  text: inline,
                });
          if (
            inlineInput !== undefined &&
            textBytes + Buffer.byteLength(inlineInput, "utf8") <= MAX_TEXT_BYTES
          ) {
            textBytes += Buffer.byteLength(inlineInput, "utf8");
            // 原因：裸文本丢失附件身份，原生队列编辑会替换掉它；携带有界内容与原始 ref 一同往返。
            result.push({
              type: "text",
              text: inlineInput,
              text_elements: [],
            });
          } else {
            result.push({
              type: "text",
              text: formatNativeFileReference({
                attachment,
                path: resolved.path,
              }),
              text_elements: [],
            });
          }
        }
      }
      return result;
    });
  }

  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    return (this.closing ??= this.tail.then(() => this.uploads.close()));
  }

  private async authorized(query: AttachmentReadAuthorization): Promise<ResolvedAttachment> {
    const denied =
      query.method === V4_METHODS.conversationAttachmentStat
        ? "shareStatNotAuthorized"
        : query.method === V4_METHODS.conversationAttachmentRead
          ? "shareReadNotAuthorized"
          : "previewRefNotAuthorized";
    if (!this.options.authorizeRead || (await this.options.authorizeRead(query)) !== true)
      throw attachmentFault(denied);
    try {
      return await this.files.resolve(
        query.ref,
        query.sessionId,
        query.method === V4_METHODS.conversationAttachmentStat,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw attachmentFault("shareStatNotFound");
      throw error;
    }
  }
}
