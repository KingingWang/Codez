import { createHash, type Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  PROTOCOL_V4_LIMITS as LIMITS,
  type V4AttachmentBeginParams,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkParams,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitParams,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentFiles } from "./attachments-files.js";
import { attachmentFault } from "./attachments-types.js";

type Stage = {
  metadata: V4AttachmentBeginParams;
  path: string;
  file: FileHandle;
  received: number;
  chunks: { bytes: number; hash: string }[];
  hash: Hash;
  expires: number;
};
type Receipt = { metadata: V4AttachmentBeginParams; ref: string; expires: number };
const key = (params: V4AttachmentCommitParams) =>
  JSON.stringify([params.connectionId, params.sessionId, params.uploadId]);
const same = (a: V4AttachmentBeginParams, b: V4AttachmentBeginParams) =>
  a.fileName === b.fileName &&
  a.mime === b.mime &&
  a.totalBytes === b.totalBytes &&
  a.totalChunks === b.totalChunks &&
  a.checksum === b.checksum;

/** Called only through AttachmentStore serial admission; never accumulates attachment contents. */
export class AttachmentUploads {
  private readonly staged = new Map<string, Stage>();
  private readonly receipts = new Map<string, Receipt>();
  private reservedBytes = 0;
  constructor(
    private readonly files: AttachmentFiles,
    private readonly now: () => number,
  ) {}

  async prune(): Promise<void> {
    for (const [id, stage] of this.staged)
      if (stage.expires <= this.now()) await this.remove(id, stage);
    for (const [id, receipt] of this.receipts)
      if (receipt.expires <= this.now()) this.receipts.delete(id);
  }

  async begin(params: V4AttachmentBeginParams): Promise<V4AttachmentBeginResult> {
    const id = key(params);
    const receipt = this.receipts.get(id);
    const stage = this.staged.get(id);
    if (receipt || stage) {
      if (!same((receipt ?? stage)!.metadata, params)) throw attachmentFault("beginConflict");
      if (receipt)
        return {
          uploadId: params.uploadId,
          state: "committed",
          nextChunkIndex: params.totalChunks,
          ref: receipt.ref,
        };
      stage!.expires = this.now() + LIMITS.attachmentUploadTtlMs;
      return { uploadId: params.uploadId, state: "staging", nextChunkIndex: stage!.chunks.length };
    }
    if (this.staged.size >= LIMITS.attachmentUploadMaxConcurrent)
      throw attachmentFault("tooManyUploads");
    if (params.totalBytes > params.totalChunks * LIMITS.attachmentChunkMaxBytes)
      throw attachmentFault("chunkCountInsufficient");
    if (params.totalChunks > params.totalBytes) throw attachmentFault("chunkCountExcessive");
    if (this.reservedBytes + params.totalBytes > LIMITS.attachmentUploadMaxStagedBytes)
      throw attachmentFault("stagingCapacityExceeded");
    const { path, file } = await this.files.stage();
    this.staged.set(id, {
      metadata: params,
      path,
      file,
      received: 0,
      chunks: [],
      hash: createHash("sha256"),
      expires: this.now() + LIMITS.attachmentUploadTtlMs,
    });
    this.reservedBytes += params.totalBytes;
    return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 };
  }

  async chunk(params: V4AttachmentChunkParams): Promise<V4AttachmentChunkResult> {
    const id = key(params);
    const stage = this.staged.get(id);
    if (!stage) throw attachmentFault("uploadNotFound");
    const bytes = Buffer.from(params.dataBase64, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const prior = stage.chunks[params.chunkIndex];
    if (prior) {
      if (prior.bytes !== bytes.length || prior.hash !== hash)
        throw attachmentFault("chunkConflict");
      return { uploadId: params.uploadId, nextChunkIndex: stage.chunks.length };
    }
    if (params.chunkIndex > stage.chunks.length) throw attachmentFault("chunkGap");
    if (params.chunkIndex >= stage.metadata.totalChunks) throw attachmentFault("tooManyChunks");
    if (!bytes.length) throw attachmentFault("emptyChunk");
    if (stage.received + bytes.length > stage.metadata.totalBytes)
      throw attachmentFault("totalBytesExceeded");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await stage.file.write(
          bytes,
          offset,
          bytes.length - offset,
          stage.received + offset,
        );
        if (!result.bytesWritten) throw attachmentFault("writeFailed");
        offset += result.bytesWritten;
      }
    } catch (error) {
      await this.remove(id, stage);
      throw error;
    }
    stage.hash.update(bytes);
    stage.received += bytes.length;
    stage.chunks.push({ bytes: bytes.length, hash });
    stage.expires = this.now() + LIMITS.attachmentUploadTtlMs;
    return { uploadId: params.uploadId, nextChunkIndex: stage.chunks.length };
  }

  async commit(params: V4AttachmentCommitParams): Promise<{ ref: string }> {
    const id = key(params);
    const receipt = this.receipts.get(id);
    if (receipt) return { ref: receipt.ref };
    const stage = this.staged.get(id);
    if (!stage) throw attachmentFault("uploadNotFound");
    if (
      stage.received !== stage.metadata.totalBytes ||
      stage.chunks.length !== stage.metadata.totalChunks
    )
      throw attachmentFault("uploadIncomplete");
    if (`sha256:${stage.hash.copy().digest("hex")}` !== stage.metadata.checksum)
      throw attachmentFault("checksumMismatch");
    try {
      await stage.file.sync();
      await stage.file.close();
      const ref = await this.files.publish(stage.path, stage.metadata);
      this.receipts.set(id, {
        metadata: stage.metadata,
        ref,
        expires: this.now() + LIMITS.attachmentUploadTtlMs,
      });
      if (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value!);
      return { ref };
    } finally {
      await this.remove(id, stage);
    }
  }

  async abort(params: V4AttachmentCommitParams): Promise<Record<string, never>> {
    const id = key(params);
    const stage = this.staged.get(id);
    if (stage) await this.remove(id, stage);
    return {};
  }

  async close(): Promise<void> {
    for (const [id, stage] of this.staged) await this.remove(id, stage);
    this.receipts.clear();
  }

  private async remove(id: string, stage: Stage): Promise<void> {
    await stage.file.close();
    await this.files.discard(stage.path);
    this.staged.delete(id);
    this.reservedBytes -= stage.metadata.totalBytes;
  }
}
