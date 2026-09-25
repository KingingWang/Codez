import { createHash } from "node:crypto";

export const CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES = 262_144;
export const CODEZ_SHARED_CONTEXT_CONTENT_COPY_FORMAT_VERSION = 1;

export interface SharedContextContentCopyRecord {
  readonly contextId: string;
  readonly sessionId: string;
  readonly shareId: string;
  readonly title: string;
  readonly shareUrl?: string;
  readonly workspaceKey: string;
  readonly formatVersion: number;
  readonly formatterVersion: number;
  readonly content: string;
  readonly capturedAt?: number;
}

export interface SharedContextContentCopyReadInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly sessionId: string;
  readonly contextId: string;
}

export type SharedContextContentCopyReader = (
  input: SharedContextContentCopyReadInput,
) => Promise<SharedContextContentCopyRecord>;

export type SharedContextRefInput = {
  readonly kind: "shared_context_import";
  readonly context_id: string;
};

export class SharedContextContentCopyError extends Error {
  readonly reasonCode: string;
  readonly limit?: number;
  readonly observedBytes?: number;

  constructor(
    reasonCode: string,
    message: string,
    details?: { limit?: number; observedBytes?: number },
  ) {
    super(message);
    this.name = "SharedContextContentCopyError";
    this.reasonCode = reasonCode;
    if (details?.limit !== undefined) this.limit = details.limit;
    if (details?.observedBytes !== undefined) this.observedBytes = details.observedBytes;
  }
}

function workspaceKeyOf(input: { workspacePath: string; workspaceIdentity?: string }): string {
  return input.workspaceIdentity?.trim() || input.workspacePath;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function isOpaqueContextId(contextId: string): boolean {
  // context_id 只允许 opaque 标识符；渲染层传入路径或 URL 时必须在读取前拒绝，
  // 避免 Host reader 被诱导触碰存储路径。
  return /^[A-Za-z0-9_-]+$/.test(contextId);
}

function formatRecord(record: SharedContextContentCopyRecord, expandedAt: number): string {
  const contentSha256 = createHash("sha256").update(record.content, "utf8").digest("hex");
  return [
    "===== CODEZ SHARED CONTEXT COPY BEGIN =====",
    `Source: conversation-share-import`,
    `Context ID: ${record.contextId}`,
    `Session ID: ${record.sessionId}`,
    `Share ID: ${record.shareId}`,
    `Title: ${record.title}`,
    ...(record.shareUrl ? [`Share URL: ${record.shareUrl}`] : []),
    ...(record.capturedAt !== undefined
      ? [`Captured at: ${formatTimestamp(record.capturedAt)}`]
      : []),
    `Expanded at: ${formatTimestamp(expandedAt)}`,
    `Workspace key: ${record.workspaceKey}`,
    `Copy format version: ${record.formatVersion}`,
    `Formatter version: ${record.formatterVersion}`,
    `Content SHA-256: ${contentSha256}`,
    "===== CONTENT BEGIN =====",
    record.content,
    "===== CONTENT END =====",
    "===== CODEZ SHARED CONTEXT COPY END =====",
  ].join("\n");
}

export async function expandSharedContextContentCopy(input: {
  text: string;
  refs: readonly SharedContextRefInput[];
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  read: SharedContextContentCopyReader;
  now?: () => number;
}): Promise<string> {
  const refs = input.refs;
  if (refs.length === 0) {
    throw new SharedContextContentCopyError("empty", "Shared context reference list is empty");
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.kind !== "shared_context_import") {
      throw new SharedContextContentCopyError(
        "unknown_kind",
        "Shared context reference kind is unsupported",
      );
    }
    const contextId = ref.context_id?.trim();
    if (!contextId) {
      throw new SharedContextContentCopyError(
        "invalid_context_id",
        "Shared context reference has no context id",
      );
    }
    if (!isOpaqueContextId(contextId)) {
      throw new SharedContextContentCopyError(
        "invalid_context_id",
        "Shared context reference must be an opaque context id",
      );
    }
    if (seen.has(contextId)) {
      throw new SharedContextContentCopyError(
        "duplicate_context_id",
        "Shared context contains a duplicate context id",
      );
    }
    seen.add(contextId);
  }

  const records: SharedContextContentCopyRecord[] = [];
  for (const ref of refs) {
    const record = await input.read({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      sessionId: input.sessionId,
      contextId: ref.context_id,
    });
    if (record.contextId !== ref.context_id) {
      throw new SharedContextContentCopyError(
        "context_mismatch",
        "Shared context reader returned a different context id",
      );
    }
    if (record.sessionId !== input.sessionId) {
      throw new SharedContextContentCopyError(
        "session_mismatch",
        "Shared context does not belong to the current session",
      );
    }
    if (record.workspaceKey !== workspaceKeyOf(input)) {
      throw new SharedContextContentCopyError(
        "workspace_mismatch",
        "Shared context does not belong to the authorized workspace",
      );
    }
    if (record.formatVersion !== CODEZ_SHARED_CONTEXT_CONTENT_COPY_FORMAT_VERSION) {
      throw new SharedContextContentCopyError(
        "unknown_formatter",
        "Shared context copy format is unsupported",
        { observedBytes: record.formatVersion },
      );
    }
    if (record.formatterVersion !== CODEZ_SHARED_CONTEXT_CONTENT_COPY_FORMAT_VERSION) {
      throw new SharedContextContentCopyError(
        "unknown_formatter",
        "Shared context formatter version is unsupported",
        { observedBytes: record.formatterVersion },
      );
    }
    if (!record.content) {
      throw new SharedContextContentCopyError("empty_content", "Shared context content is empty");
    }
    records.push(record);
  }

  const expanded = records
    .map((record) => formatRecord(record, (input.now ?? Date.now)()))
    .join("\n\n");
  const observedBytes = new TextEncoder().encode(expanded).byteLength;
  if (observedBytes > CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES) {
    throw new SharedContextContentCopyError(
      "byte_limit_exceeded",
      "Shared context content copy exceeds the byte limit",
      { limit: CODEZ_SHARED_CONTEXT_CONTENT_COPY_MAX_BYTES, observedBytes },
    );
  }
  return input.text ? `${input.text}\n\n${expanded}` : expanded;
}
