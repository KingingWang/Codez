import { createHash } from "node:crypto";
import { attachmentRefSchema, type AttachmentRef } from "@codez/shared/codez-protocol-v4";

const PREFIX = "CODEZ_FILE_REF_V1:";
const INLINE_PREFIX = "CODEZ_INLINE_FILE_V1:";
const MAX_INLINE_CHARS = 64 * 1024;
const MAX_MARKER_LENGTH = 16 * 1024;

export interface NativeFileReference {
  attachment: AttachmentRef;
  path: string;
}

export interface NativeFileReferenceMatch extends NativeFileReference {
  start: number;
  end: number;
  inlineText?: string;
  inlineChecksum?: string;
}

/** Native Codex has no generic binary input: a trusted, session-owned path is its file input. */
export function formatNativeFileReference(value: NativeFileReference): string {
  const marker = Buffer.from(JSON.stringify(value)).toString("base64url");
  // 文件名仅以 JSON 字符串呈现；不可把剪贴板提供的名字当成指令或可读路径。
  return `${PREFIX}${marker}\nAttached file ${JSON.stringify(value.attachment.fileName)} is available at ${JSON.stringify(value.path)}. Use file tools if you need to inspect its complete contents.`;
}

/** Full native text plus an owned, bounded identity envelope; never an anonymous text part. */
export function formatNativeInlineFileReference(
  value: NativeFileReference & { text: string },
): string {
  const { text, attachment, path } = value;
  const checksum = createHash("sha256").update(text, "utf8").digest("hex");
  const marker = Buffer.from(
    JSON.stringify({ attachment, path, textLength: text.length, checksum }),
  ).toString("base64url");
  return `${INLINE_PREFIX}${marker}\nAttached file ${JSON.stringify(attachment.fileName)} is available at ${JSON.stringify(path)}. Its complete contents follow:\n${text}`;
}

export function parseNativeFileReference(text: string): NativeFileReference | undefined {
  const [match] = extractNativeFileReferences(text);
  return match?.inlineText === undefined && match?.start === 0 && match.end === text.length
    ? { attachment: match.attachment, path: match.path }
    : undefined;
}

/** Native history can merge adjacent text parts; recover both file modes within merged content. */
export function extractNativeFileReferences(text: string): NativeFileReferenceMatch[] {
  const matches: NativeFileReferenceMatch[] = [];
  let cursor = 0;
  for (;;) {
    const pathStart = text.indexOf(PREFIX, cursor);
    const inlineStart = text.indexOf(INLINE_PREFIX, cursor);
    const start =
      pathStart < 0 ? inlineStart : inlineStart < 0 ? pathStart : Math.min(pathStart, inlineStart);
    if (start < 0) return matches;
    const inline = start === inlineStart;
    cursor = start + (inline ? INLINE_PREFIX.length : PREFIX.length);
    const newline = text.indexOf("\n", cursor);
    if (newline < 0 || newline - cursor > MAX_MARKER_LENGTH) continue;
    const encoded = text.slice(cursor, newline);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) continue;
    try {
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) continue;
      const value: unknown = JSON.parse(decoded.toString("utf8"));
      if (!value || typeof value !== "object" || !("path" in value) || !("attachment" in value))
        continue;
      const path = value.path;
      if (typeof path !== "string" || !path) continue;
      const attachment = attachmentRefSchema.parse(value.attachment);
      if (inline) {
        const textLength = "textLength" in value ? value.textLength : undefined;
        const checksum = "checksum" in value ? value.checksum : undefined;
        if (
          typeof textLength !== "number" ||
          !Number.isSafeInteger(textLength) ||
          textLength < 1 ||
          textLength > MAX_INLINE_CHARS ||
          typeof checksum !== "string" ||
          !/^[0-9a-f]{64}$/u.test(checksum)
        )
          continue;
        const header = `Attached file ${JSON.stringify(attachment.fileName)} is available at ${JSON.stringify(path)}. Its complete contents follow:\n`;
        if (!text.startsWith(header, newline + 1)) continue;
        const bodyStart = newline + 1 + header.length;
        const body = text.slice(bodyStart, bodyStart + textLength);
        if (body.length !== textLength) continue;
        const formatted = formatNativeInlineFileReference({ attachment, path, text: body });
        if (!text.startsWith(formatted, start)) continue;
        matches.push({
          attachment,
          path,
          start,
          end: start + formatted.length,
          inlineText: body,
          inlineChecksum: `sha256:${checksum}`,
        });
        cursor = start + formatted.length;
        continue;
      }
      const formatted = formatNativeFileReference({ attachment, path });
      if (!text.startsWith(formatted, start)) continue;
      matches.push({ attachment, path, start, end: start + formatted.length });
      cursor = start + formatted.length;
    } catch {
      continue;
    }
  }
}
