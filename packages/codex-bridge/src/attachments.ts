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
  findNativeAttachment(path: string, sessionId: string): Promise<AttachmentRef | undefined> {
    return this.serial(() => this.files.findNativeAttachment(path, sessionId));
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
        else if (
          resolved.mime.startsWith("text/") ||
          /^(application\/(json|xml|javascript|x-yaml))$/.test(resolved.mime)
        ) {
          textBytes += resolved.bytes;
          if (textBytes > MAX_TEXT_BYTES) throw attachmentFault("textInputLimit");
          const file = await openAttachmentFile(resolved.path, MAX_TEXT_BYTES);
          try {
            const buffer = Buffer.alloc(resolved.bytes);
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
              if (!bytesRead) throw attachmentFault("lengthMismatch");
              offset += bytesRead;
            }
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch {
              throw attachmentFault("invalidUtf8");
            }
            result.push({ type: "text", text, text_elements: [] });
          } finally {
            await file.close();
          }
        } else throw attachmentFault("nativeTypeUnsupported");
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
