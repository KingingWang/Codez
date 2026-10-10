import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  extractNativeFileReferences,
  formatNativeFileReference,
  formatNativeInlineFileReference,
  parseNativeFileReference,
} from "../src/native-file-reference.js";

const text = "完整内容\n🙂";
const attachment = {
  ref: "codez-attachment://00000000-0000-4000-8000-000000000000",
  fileName: '附件 "quoted".txt',
  mime: "text/plain",
  bytes: Buffer.byteLength(text),
};

// 使用固定路径而非宿主平台的 join，让 Linux/macOS 也覆盖 Windows 转义回归。
const paths = {
  POSIX: "/tmp/codez attachments 中文/file.data",
  "Windows drive": String.raw`C:\codez attachments 中文\objects\file.data`,
  UNC: String.raw`\\server\share\codez attachments 中文\objects\file.data`,
  "Windows verbatim": String.raw`\\?\C:\codez attachments 中文\objects\file.data`,
};

for (const [kind, path] of Object.entries(paths)) {
  test(`${kind} file reference preserves the raw path behind its JSON-escaped header`, () => {
    const reference = { attachment, path };
    const formatted = formatNativeFileReference(reference);
    assert.ok(
      formatted.includes(
        `Attached file ${JSON.stringify(attachment.fileName)} is available at ${JSON.stringify(path)}.`,
      ),
    );
    assert.deepEqual(parseNativeFileReference(formatted), reference);
    assert.deepEqual(extractNativeFileReferences(formatted), [
      { ...reference, start: 0, end: formatted.length },
    ]);
  });

  test(`${kind} inline envelope preserves its path and complete content in merged input`, () => {
    const formatted = formatNativeInlineFileReference({ attachment, path, text });
    assert.ok(
      formatted.includes(
        `Attached file ${JSON.stringify(attachment.fileName)} is available at ${JSON.stringify(path)}. Its complete contents follow:\n${text}`,
      ),
    );
    assert.equal(parseNativeFileReference(formatted), undefined);
    const prefix = "typed before\n";
    assert.deepEqual(extractNativeFileReferences(`${prefix}${formatted}\ntyped after`), [
      {
        attachment,
        path,
        start: prefix.length,
        end: prefix.length + formatted.length,
        inlineText: text,
        inlineChecksum: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
      },
    ]);
  });
}
