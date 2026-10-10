import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatComposerAttachment,
  serializeChatComposerAttachment,
} from "./chatAttachments.js";
import { uploadComposerAttachment } from "../v4/composer/attachmentUpload.js";

test("ordinary text files send complete original bytes on both sides of 64 Ki characters", async () => {
  for (const count of [64 * 1024, 64 * 1024 + 1]) {
    const content = "文".repeat(count);
    const attachment = createChatComposerAttachment(
      new File([content], "sample.html", { type: "text/html" }),
    );
    const result = await serializeChatComposerAttachment(attachment);
    assert.equal(result.kind, "file");
    const encoded = "dataBase64" in result ? result.dataBase64 : undefined;
    assert.ok(encoded, `missing complete bytes for ${count} characters`);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.equal(decoded.length, content.length);
    assert.equal(decoded, content);
    assert.equal("textContent" in result ? result.textContent : undefined, undefined);
  }
});

test("binary and empty files retain bytes instead of becoming metadata-only", async () => {
  for (const bytes of [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(0)]) {
    const result = await serializeChatComposerAttachment(
      createChatComposerAttachment(new File([bytes], "sample.zip", { type: "application/zip" })),
    );
    assert.equal(result.kind, "file");
    assert.equal("dataBase64" in result ? result.dataBase64 : undefined, bytes.toString("base64"));
  }
});

test("upload without a local path refuses files above 20 MiB before reading", async () => {
  const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.bin");
  await assert.rejects(
    serializeChatComposerAttachment(createChatComposerAttachment(file)),
    /oversized-inline-file-attachment/,
  );
});

test("a file exactly at the 20 MiB upload boundary retains its final byte", async () => {
  const bytes = new Uint8Array(20 * 1024 * 1024);
  bytes[bytes.length - 1] = 0x7f;
  const result = await serializeChatComposerAttachment(
    createChatComposerAttachment(new File([bytes], "boundary.bin")),
  );
  assert.equal(result.kind, "file");
  const encoded = "dataBase64" in result ? result.dataBase64 : undefined;
  assert.ok(encoded);
  const decoded = Buffer.from(encoded, "base64");
  assert.equal(decoded.length, bytes.length);
  assert.equal(decoded.at(-1), 0x7f);
});

test("zero-byte and clipboard-text refs retain a real upload and source kind", async () => {
  const result = await uploadComposerAttachment(
    async (params) => {
      assert.equal(params.dataBase64, "");
      return { ref: "codez-attachment://empty" };
    },
    "session-1",
    {
      kind: "file",
      filename: "pasted.txt",
      mimeType: "text/plain",
      sizeBytes: 0,
      dataBase64: "",
      sourceKind: "clipboard-text",
    },
  );
  assert.equal(result?.bytes, 0);
  assert.equal(result?.sourceKind, "clipboard-text");
});
