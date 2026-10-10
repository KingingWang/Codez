// 附件命令面：AttachmentRef（引用模型）→ core TurnAttachment 的协议边界映射。
//
// ref 的两种形态（与投影侧 buildUserInputRow 的「本地路径 / artifact URI」注释对偶）：
// 1. URI ref（codez-artifact:// 等带 scheme:/）——经 attachment chunk transaction 寄存的内容引用：
//    - 图片：content 直接携带 URI，core 的 attachment-artifacts 解析链在模型请求时
//      读回 data URL（与 externalizePromptAttachments 的产物同形，不在这里内联解码，
//      避免大图在命令层放大内存）。
//    - PDF：保留 URI 交给 core 的 PDF resolver；其他非图片：从会话 artifact
//      物化原始字节为 Agent 可读私有路径，再由 core 决定全文或路径引用。
// 2. 本地路径 ref（desktop 直传绝对路径）——按旧 mapProtocolPromptAttachment 的
//    localPath 分支映射为 path 引用，core 已有读取阈值与降级策略。
import type { TurnAttachment } from "@codez/core";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import type { CodezApp } from "../../app/types.js";

const URI_REF_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function isUriAttachmentRef(ref: string): boolean {
  return URI_REF_PATTERN.test(ref);
}

function displayMetaOf(
  ref: AttachmentRef,
): Pick<TurnAttachment, "filename" | "mimeType" | "sizeBytes" | "sourceKind"> {
  return {
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
    ...(ref.sourceKind ? { sourceKind: ref.sourceKind } : {}),
  };
}

function isImageRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isVideoRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("video/") ?? false;
}

function isPdfRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

async function mapAttachmentRef(app: CodezApp, ref: AttachmentRef): Promise<TurnAttachment> {
  const displayMeta = displayMetaOf(ref);
  if (!isUriAttachmentRef(ref.ref)) {
    // 本地路径引用：交给 core 的文件/图片读取链路（阈值与降级已内建）。
    if (isVideoRef(ref)) {
      return { path: ref.ref, type: "video", ...displayMeta };
    }
    return {
      path: ref.ref,
      type: isImageRef(ref) ? "image" : isPdfRef(ref) ? "pdf" : "file",
      ...displayMeta,
    };
  }
  if (isImageRef(ref)) {
    // 图片 URI ref：content 携带 artifact URI，模型请求阶段由 resolveAttachmentDataUrl
    // 读回（与 externalizePromptAttachments 产物同形，天然免二次外置）。
    return { content: ref.ref, path: ref.fileName, type: "image", ...displayMeta };
  }
  if (isVideoRef(ref)) {
    // video URI ref：与图片同构——content 携带 artifact URI，模型请求阶段读回 data URL。
    return { content: ref.ref, path: ref.fileName, type: "video", ...displayMeta };
  }
  if (isPdfRef(ref)) {
    // PDF URI ref 必须保留 durable URI，交给 core 读取 data URL；不能按 UTF-8 文本解码。
    return { content: ref.ref, path: ref.fileName, type: "pdf", ...displayMeta };
  }
  // 原因：旧路径超过 64KiB 就只留下元信息，模型既未见全文，也无法按路径读取。
  // 缺失或物化失败必须拒绝本次发送，保留草稿供重试，绝不能伪造成功。
  return {
    path: await app.materializePromptAttachment(ref.ref),
    type: "file",
    ...displayMeta,
  };
}

/**
 * sendText/createSession/editUserQuery 共用：attachments 引用数组 → core TurnAttachment[]。
 * 空数组/缺省 → undefined（sendInput 语义：无附件不带字段）。
 */
export async function mapAttachmentRefsToTurnAttachments(
  app: CodezApp,
  refs: readonly AttachmentRef[] | undefined,
): Promise<TurnAttachment[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const mapped = await Promise.all(refs.map((ref) => mapAttachmentRef(app, ref)));
  return mapped.length > 0 ? mapped : undefined;
}
