import assert from "node:assert/strict";
import test from "node:test";
import type { FileSystemPort, TraceContext } from "@codez/contracts";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";

async function resolveFile(
  bytes: Buffer,
  options: {
    filename?: string;
    mimeType?: string;
    sourceKind?: "clipboard-text";
    truncated?: boolean;
  } = {},
) {
  const text = bytes.toString("utf8");
  const fileSystemPort = {
    stat: async () => ({ path: "/workspace/original.txt", kind: "file", sizeBytes: bytes.length }),
    readBinaryFile: async () => ({
      path: "/workspace/original.txt",
      content: bytes,
      bytesRead: bytes.length,
      sizeBytes: bytes.length,
    }),
    readTextFileRange: async () => ({
      path: "/workspace/original.txt",
      content: text,
      encoding: "utf8",
      bytesRead: bytes.length,
      sizeBytes: bytes.length,
      truncated: options.truncated ?? false,
      startLine: 1,
      lineCount: 1,
      totalLines: 1,
    }),
  } as unknown as FileSystemPort;
  const [result] = await resolveTurnAttachments(
    [{
      type: "file",
      path: "/workspace/original.txt",
      filename: options.filename ?? "original.txt",
      mimeType: options.mimeType ?? "text/plain",
      sizeBytes: bytes.length,
      ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
    }],
    {
      workingDirectory: "/workspace",
      traceContext: {} as TraceContext,
      fileSystemPort,
    },
  );
  return result;
}

test("a small prompt text attachment is complete, never a prefix", async () => {
  const file = await resolveFile(Buffer.from("hello"));
  assert.equal(file?.contentBlock.type, "text");
  assert.equal(file?.contentBlock.type === "text" ? file.contentBlock.text : null, "hello");
});

test("too many characters, partial adapter reads, and long paste are path-only", async () => {
  for (const [bytes, options] of [
    [Buffer.from("a".repeat(64 * 1024 + 1)), {}],
    [Buffer.from("hello"), { truncated: true }],
    [Buffer.from("hello"), { sourceKind: "clipboard-text" as const }],
  ] as const) {
    const file = await resolveFile(bytes, options);
    assert.equal(file?.metadata.storageKind, "local_ref");
    assert.ok(file?.contentBlock.type === "text");
    assert.ok(!file.contentBlock.text.includes(bytes.toString("utf8")));
    assert.ok(file.contentBlock.text.includes("/workspace/original.txt"));
  }
});

test("invalid UTF-8 under a text MIME is delivered as an original path", async () => {
  const file = await resolveFile(Buffer.from([0xc3, 0x28]));
  assert.equal(file?.metadata.storageKind, "local_ref");
});

test("a ZIP misdeclared as text/plain is an original path, even with a .txt name", async () => {
  const file = await resolveFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(file?.metadata.storageKind, "local_ref");
  assert.ok(file?.contentBlock.type === "text");
  assert.ok(file.contentBlock.text.includes("/workspace/original.txt"));
});

test("an empty .txt is delivered as a readable path, not empty model text", async () => {
  const file = await resolveFile(Buffer.alloc(0));
  assert.equal(file?.metadata.storageKind, "local_ref");
  assert.ok(file?.contentBlock.type === "text");
  assert.ok(file.contentBlock.text.includes("/workspace/original.txt"));
});

test("a file within the character cap but over the model output-token cap is not partially read", async () => {
  const file = await resolveFile(Buffer.from("文".repeat(60_000)));
  assert.equal(file?.metadata.storageKind, "local_ref");
  assert.ok(file?.contentBlock.type === "text");
  assert.ok(!file.contentBlock.text.includes("文文文"));
});
