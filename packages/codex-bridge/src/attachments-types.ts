import type { ConversationRowTarget } from "@codez/shared/codez-protocol-v4";

/**
 * Attachment slice specification:
 * - One store owns staging and serial admission; no Codex/session authority is duplicated.
 * - Exact (connectionId, sessionId, uploadId) tuples identify retryable upload transactions.
 * - Drafts use their nonempty sessionId unchanged; no cross-session promotion is inferred.
 * - begin -> bounded disk chunks -> byte-count/SHA-256 verification -> atomic manifest publish.
 * - Abort/TTL/close delete staging only. Committed refs persist across process restarts.
 * - Client refs are opaque UUIDs, never paths. Persistent metadata owns MIME and session scope.
 * - Native-path reverse lookup accepts only the exact <root>/objects/<uuid>.data spelling;
 *   it derives a ref and reuses manifest ownership plus byte/checksum verification, without
 *   scanning directories or reading caller-selected files. It works after a store restart.
 * - Native-path lookup returns undefined for unrelated paths, missing files and scope mismatches;
 *   corrupt/unsafe storage and lifecycle failures reject. It does not authorize a user row.
 * - Trusted native userMessage URLs accept canonical base64 PNG/JPEG/WebP/GIF only,
 *   bounded by attachmentMaxBytes. This host-only API must not expose client URL admission.
 *   URL -> decoded SHA-256/length -> owned manifest -> verified blob -> ref -> main row gate.
 *   Restart lookup scans at most 4096 trusted object-directory entries (lookupLimit otherwise);
 *   no URL fetch or caller path read. Same-session duplicate bytes select the lowest UUID.
 *   No index/cache or migration is needed; each lookup rechecks persisted ownership/integrity.
 * - An unmatched authoritative native image is staged/published as a session-owned derived
 *   preview (manifest derived:true, MIME-whitelisted filename). This covers resize/fork/CLI
 *   history without shadowing execution state. No cross-session ref reuse or implicit read
 *   authorization; main still gates the current user row. Text boundaries cannot be recovered.
 * - Desktop continuous and mobile replayable use the same transactions and authorization.
 * - Read/stat require a fresh authoritative user-row check from main on every call.
 * - Native conversion is all-or-error: images become localImage, UTF-8 text becomes text;
 *   unsupported/binary content is never silently omitted. Main owns session/row admission.
 * - Idempotency receipts are process-local, TTL-bound and capped at 512; no crash exactly-once.
 * - Storage is private to this bridge, not a legacy artifact or credential migration.
 */
export interface AttachmentStoreOptions {
  cwd: string;
  /** Trusted host path; defaults to <cwd>/.codez/codex-bridge/attachments. */
  root?: string;
  /** Must check current session user row, target and index, including optional legacy targets. */
  authorizeRead?: (query: AttachmentReadAuthorization) => boolean | Promise<boolean>;
  /** Clock injection for deterministic expiry tests. */
  now?: () => number;
}

export interface AttachmentReadAuthorization {
  method: string;
  sessionId: string;
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

export interface ResolvedAttachment {
  ref: string;
  path: string;
  sessionId: string;
  fileName: string;
  mime: string;
  bytes: number;
  checksum: string;
}

/** Stable fault codes survive the bridge's JSON-RPC error adapter. */
export function attachmentFault(name: string): Error & { code: string } {
  const code = `fault.attachment.${name}`;
  return Object.assign(new Error(code), { code });
}
