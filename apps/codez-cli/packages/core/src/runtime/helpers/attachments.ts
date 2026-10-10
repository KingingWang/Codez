import { basename, resolvePath } from "../deps.js";
import { isCoreError, READ_MAX_FILE_SIZE_BYTES } from "@codez/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnAttachmentMeta,
  TurnState,
  TurnId,
} from "../deps.js";
import { readTextFileForModel } from "../../tool/handlers/read-text.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { readInlineAttachmentContent } from "./attachment-artifacts.js";
import { parseDataUrlHeader } from "./attachment-data-url.js";
import {
  resolveInlineMediaAttachment,
  resolveLocalMediaAttachment,
} from "./attachment-media-resolver.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath } from "./attachment-image.js";
import {
  inferAttachmentMimeFromPath,
  isDataOrArtifactUrl,
  isTextLikePath,
  resolvedInlineTextAttachment,
  resolvedPathReferenceAttachment,
} from "./attachment-path-reference.js";

type ResolveAttachmentOptions = {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
};

function isKnownBinaryFile(filename: string): boolean {
  return /\.(7z|avi|db|docx?|exe|gif|gz|jpe?g|mp[34]|pdf|png|rar|sqlite|tar|wasm|webp|woff2?|xlsx?|zip)$/iu.test(
    filename,
  );
}

function hasBinaryBytes(bytes: Uint8Array): boolean {
  // 原因：PK ZIP 头本身是合法 UTF-8；即使 MIME/文件名都声称是纯文本也不能预读压缩包。
  if (
    (bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 3 && bytes[3] === 4) ||
        (bytes[2] === 5 && bytes[3] === 6) ||
        (bytes[2] === 7 && bytes[3] === 8))) ||
    (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b)
  )
    return true;
  return bytes.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)));
}

/**
 * 附件 → TurnStarted 事件的轻量展示元信息（TurnAttachmentMeta）。
 * 在 resolve/persist 之前即可用（TurnStarted 先于 resolveTurnAttachments 发出），
 * 因此只做无 IO 推断：filename/mimeType/sizeBytes 优先取协议边界透传值，
 * 缺省按 path basename / 扩展名 / data URL 头 / content 长度兜底。
 */
export function summarizeTurnAttachmentsForEvent(
  attachments: TurnState["attachments"],
): TurnAttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => {
    const path = attachment.path;
    const fileName =
      attachment.filename ?? (path ? basename(path) : undefined) ?? `attachment-${index + 1}`;
    const dataUrlMime =
      attachment.content !== undefined
        ? parseDataUrlHeader(attachment.content)?.mediaType
        : undefined;
    const mime =
      attachment.mimeType ??
      dataUrlMime ??
      (attachment.type === "url"
        ? "text/uri-list"
        : path
          ? attachment.type === "image"
            ? inferImageMimeFromPath(path)
            : inferAttachmentMimeFromPath(path)
          : "application/octet-stream");
    const bytes =
      attachment.sizeBytes ??
      (attachment.content !== undefined ? Buffer.byteLength(attachment.content, "utf8") : 0);
    // data URL/inline 内容无稳定引用；路径/URL 作为展示层引用。
    const ref =
      path && !isDataOrArtifactUrl(path)
        ? path
        : attachment.type === "url"
          ? (attachment.content ?? path)
          : undefined;
    return { fileName, mime, bytes, ...(ref ? { ref } : {}) };
  });
}

export async function resolveTurnAttachments(
  attachments: TurnState["attachments"],
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment[]> {
  const resolved: ResolvedTurnAttachment[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    resolved.push(await resolveTurnAttachment(attachment, index, options));
  }
  return resolved;
}

async function resolveTurnAttachment(
  attachment: TurnAttachment,
  index: number,
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment> {
  if (attachment.type === "url") {
    const uri = attachment.content ?? attachment.path ?? `attachment-${index + 1}`;
    return {
      contentBlock: { type: "resource_link", uri },
      metadata: {
        originalUrl: uri,
        recoverability: "metadata_only",
        storageKind: "remote_ref",
      },
      mime: "text/uri-list",
      url: uri,
    };
  }

  if (attachment.content) {
    if (attachment.type === "pdf" && !isDataOrArtifactUrl(attachment.content)) {
      // PDF 曾沿用普通 file 的 inline 文本分支，损坏或伪造的正文会被 UTF-8
      // 解码后送进 provider；PDF 必须只接受 data URL 或 artifact URI，并在请求前明确降级。
      return resolvedPlaceholderAttachment(
        attachment,
        attachment.path ?? `attachment-${index + 1}`,
        "attachment_pdf_invalid",
        {
          filename: attachment.filename,
          mime: "application/pdf",
          sizeBytes: attachment.sizeBytes,
        },
      );
    }
    if (attachment.type !== "image" && !isDataOrArtifactUrl(attachment.content)) {
      return resolvedInlineTextAttachment(attachment, index);
    }

    const inline = await readInlineAttachmentContent(attachment, options);
    if (!inline) {
      const placeholder = attachment.path ?? `attachment-${index + 1}`;
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
    }
    return await resolvedInlineAttachment({ ...attachment, content: inline.dataUrl }, index, {
      ...options,
      existingArtifactUri: inline.artifactUri,
    });
  }

  const fileSystemPort = options.fileSystemPort;
  if (attachment.path && fileSystemPort) {
    if (attachment.type === "image" || attachment.type === "video" || attachment.type === "pdf") {
      return await resolveLocalMediaAttachment(attachment, index, {
        ...options,
        fileSystemPort,
      });
    }
    return await resolveLocalFileAttachment(attachment, {
      ...options,
      fileSystemPort,
    });
  }

  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
}

async function resolvedInlineAttachment(
  attachment: TurnAttachment,
  index: number,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    imageProcessorPort?: ImageProcessorPort;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<ResolvedTurnAttachment> {
  const parsed = attachment.content?.startsWith("data:")
    ? parseDataUrlHeader(attachment.content)
    : undefined;
  const media = await resolveInlineMediaAttachment(attachment, index, parsed?.mediaType, options);
  if (media) return media;

  const content = attachment.content ?? "";
  return {
    contentBlock: { type: "text", text: content },
    metadata: {
      originalUrl: attachment.path ?? attachment.content,
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: parsed?.mediaType ?? (attachment.type === "image" ? "image/*" : "text/plain"),
    url: attachment.content ?? "",
  };
}

async function resolveLocalFileAttachment(
  attachment: TurnAttachment,
  options: {
    abortSignal?: AbortSignal;
    fileSystemPort: FileSystemPort;
    traceContext: TraceContext;
    workingDirectory: string;
  },
): Promise<ResolvedTurnAttachment> {
  const absolutePath = resolvePath(options.workingDirectory, attachment.path!);
  const filename = attachment.filename ?? basename(absolutePath);
  const mime = "text/plain";
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachment.path!, start: 0, end: attachment.path!.length },
  };

  try {
    const stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
    if (stat.kind !== "file") {
      return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_not_file", {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
      });
    }

    if (stat.sizeBytes === 0) {
      // 原因：空文本的模型输入也是空的；交付可读取路径才保留文件存在这一事实。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: attachment.mimeType ?? mime,
        sizeBytes: 0,
        source,
        reason: "empty_file",
      });
    }

    const declaredMime = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
    const textLike =
      !isKnownBinaryFile(filename) &&
      (declaredMime?.startsWith("text/") ||
        /^(application\/(json|xml|javascript|x-yaml))$/u.test(declaredMime ?? "") ||
        ((!declaredMime || declaredMime === "application/octet-stream") && isTextLikePath(filename)));
    if (!textLike) {
      // 疑似二进制文件不能误当文本读入 prompt，只交付路径引用给后续工具处理。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: attachment.mimeType ?? inferAttachmentMimeFromPath(filename),
        sizeBytes: stat.sizeBytes,
        source,
        reason: "binary_file",
      });
    }

    if (attachment.sourceKind === "clipboard-text") {
      // 长粘贴文本已经落成临时文件，预读会重新把正文塞进 prompt_attachment 系统提示。
      // 这里只交付真实本地附件引用，等模型明确需要时再通过文件读取工具进入上下文。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
        reason: "deferred_clipboard_text",
      });
    }

    const pathReference = () =>
      resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: attachment.mimeType ?? "text/plain",
        sizeBytes: stat.sizeBytes,
        source,
        reason: "text_too_large",
      });
    if (stat.sizeBytes > READ_MAX_FILE_SIZE_BYTES) return pathReference();
    const raw = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: READ_MAX_FILE_SIZE_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
    if (hasBinaryBytes(raw.content)) {
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: attachment.mimeType ?? inferAttachmentMimeFromPath(filename),
        sizeBytes: stat.sizeBytes,
        source,
        reason: "binary_file",
      });
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.content);
    } catch {
      // 原因：MIME/扩展名不能证明内容是有效文本；替换字符会不可逆地改变原文件。
      return pathReference();
    }
    if (decoded.length > 64 * 1024) return pathReference();
    const read = await readTextFileForModel({
      abortSignal: options.abortSignal,
      allowPartialFallback: false,
      filePath: absolutePath,
      fileSystemPort: options.fileSystemPort,
      trace: options.traceContext,
    });
    if (read.truncated || read.content !== decoded.replace(/\r\n?/gu, "\n"))
      return pathReference();
    return {
      contentBlock: { type: "text", text: read.content },
      filename,
      metadata: {
        originalUrl: attachment.path,
        preview: {
          text: read.content,
          truncated: read.truncated ?? false,
          ...(read.sizeBytes !== undefined ? { originalBytes: read.sizeBytes } : {}),
          startLine: read.startLine,
          totalLines: read.totalLines,
          ...(read.truncatedByTokenCap !== undefined
            ? { truncatedByTokenCap: read.truncatedByTokenCap }
            : {}),
          ...(read.partialViewNotice !== undefined
            ? { partialViewNotice: read.partialViewNotice }
            : {}),
        },
        recoverability: read.truncated ? "preview_only" : "provider_ready",
        ...(read.sizeBytes !== undefined ? { sizeBytes: read.sizeBytes } : {}),
        storageKind: "inline",
      },
      mime: "text/plain",
      source,
      url: attachment.path!,
    };
  } catch (error) {
    if (isCoreError(error) && error.context?.code === "read_output_too_many_tokens") {
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: attachment.mimeType ?? mime,
        source,
        reason: "text_too_large",
      });
    }
    throw error;
  }
}

export { parseDataUrlHeader } from "./attachment-data-url.js";
export { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
