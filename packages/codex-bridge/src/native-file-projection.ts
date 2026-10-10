import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import type { AttachmentStore } from "./attachments.js";
import type { CodexUserInput } from "./codex-types.js";
import { extractNativeFileReferences } from "./native-file-reference.js";
import { projectInputText } from "./projection-rows.js";

/** Derive UI chips only from canonical, owned native inputs; never from a client path alone. */
export async function projectOwnedInput(
  input: readonly CodexUserInput[],
  sessionId: string,
  attachments: AttachmentStore,
): Promise<{ text: string; refs: AttachmentRef[] }> {
  const refs: AttachmentRef[] = [];
  const visible: string[] = [];
  for (const part of input) {
    if (part.type === "localImage") {
      const ref = await attachments.findNativeAttachment(part.path, sessionId);
      if (ref) refs.push(ref);
    } else if (part.type === "image") {
      const ref = await attachments.findNativeImageAttachment(part.url, sessionId);
      if (ref) refs.push(ref);
    }
    if (part.type === "text") {
      const matches = extractNativeFileReferences(part.text);
      if (matches.length > 0) {
        let cursor = 0;
        let text = "";
        for (const marker of matches) {
          text += part.text.slice(cursor, marker.start);
          // 原因：合法形状的内联标记也可能被伪造；内容摘要必须与所属 blob 的校验和相同。
          const owned = await attachments.findNativeAttachment(
            marker.path,
            sessionId,
            marker.inlineChecksum,
          );
          if (
            owned &&
            owned.ref === marker.attachment.ref &&
            owned.fileName === marker.attachment.fileName &&
            owned.mime === marker.attachment.mime &&
            owned.bytes === marker.attachment.bytes
          ) {
            refs.push({
              ...owned,
              ...(marker.attachment.sourceKind ? { sourceKind: marker.attachment.sourceKind } : {}),
            });
          } else {
            text += `[file unavailable: ${marker.attachment.fileName}]`;
          }
          cursor = marker.end;
        }
        visible.push(text + part.text.slice(cursor));
        continue;
      }
    }
    visible.push(projectInputText([part]));
  }
  return { text: visible.filter(Boolean).join("\n").trimEnd(), refs };
}
