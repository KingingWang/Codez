import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  PROTOCOL_V4_LIMITS as LIMITS,
  V4_METHODS,
  v4AttachmentCommitResultSchema,
} from "@codez/shared/codez-protocol-v4";
import { AttachmentStore } from "../src/attachments.js";

const common = { connectionId: "connection", sessionId: "draft", uploadId: "upload" };
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "codez attachment security "));
  const root = join(cwd, "store");
  const store = new AttachmentStore({ cwd, root, authorizeRead: () => true });
  t.after(async () => {
    await store.close();
    await rm(cwd, { force: true, recursive: true });
  });
  return { store, root, cwd };
}
async function begin(store: AttachmentStore, bytes: Buffer, extra = {}) {
  return store.handle(V4_METHODS.attachmentBegin, {
    ...common,
    fileName: "x.txt",
    mime: "text/plain",
    totalBytes: bytes.length,
    totalChunks: Math.ceil(bytes.length / LIMITS.attachmentChunkMaxBytes),
    checksum: sha(bytes),
    ...extra,
  });
}
async function upload(store: AttachmentStore, bytes = Buffer.from("secret")) {
  await begin(store, bytes);
  for (let offset = 0; offset < bytes.length; offset += LIMITS.attachmentChunkMaxBytes) {
    await store.handle(V4_METHODS.attachmentChunk, {
      ...common,
      chunkIndex: offset / LIMITS.attachmentChunkMaxBytes,
      dataBase64: bytes
        .subarray(offset, offset + LIMITS.attachmentChunkMaxBytes)
        .toString("base64"),
    });
  }
  const { ref } = v4AttachmentCommitResultSchema.parse(
    await store.handle(V4_METHODS.attachmentCommit, common),
  );
  return { ref, bytes: bytes.length, mime: "text/plain", fileName: "x.txt" };
}

test("client paths and crafted opaque references never become filesystem inputs", async (t) => {
  const { store, cwd } = await fixture(t);
  const outside = join(cwd, "secret.txt");
  await writeFile(outside, "secret");
  for (const ref of [
    outside,
    "../../secret.txt",
    `file://${outside}`,
    "codez-attachment://../../secret.txt",
    "codez-attachment://%2e%2e%2fsecret",
    "codez-attachment://00000000-0000-4000-8000-000000000000/extra",
  ]) {
    await assert.rejects(store.resolve(ref, "draft"), /refNotAuthorized/);
    await assert.rejects(
      store.toNativeInput([{ ref, bytes: 6, mime: "text/plain", fileName: "secret" }], "draft"),
    );
  }
});

test(
  "symlinked storage directories fail closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, root, cwd } = await fixture(t);
    const outside = join(cwd, "outside");
    await mkdir(outside);
    await symlink(outside, root);
    await assert.rejects(begin(store, Buffer.from("a")), /unsafeStoragePath/);
    assert.deepEqual(await readdir(outside), []);
  },
);

test(
  "symlink and hardlink blobs cannot escape owned storage",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, cwd } = await fixture(t);
    const ref = await upload(store);
    const resolved = await store.resolve(ref.ref, "draft");
    const outside = join(cwd, "outside");
    await writeFile(outside, "secret");
    await unlink(resolved.path);
    await symlink(outside, resolved.path);
    await assert.rejects(store.resolve(ref.ref, "draft"), /unsafeStoragePath/);
    await unlink(resolved.path);
    await link(outside, resolved.path);
    await assert.rejects(store.resolve(ref.ref, "draft"), /unsafeStoragePath/);
  },
);

test("tampered blob length and checksum fail before native input", async (t) => {
  const { store } = await fixture(t);
  const ref = await upload(store);
  const { path } = await store.resolve(ref.ref, "draft");
  await writeFile(path, "short");
  await assert.rejects(store.toNativeInput([ref], "draft"), /lengthMismatch/);
  await writeFile(path, "SECRET");
  await assert.rejects(store.toNativeInput([ref], "draft"), /checksumMismatch/);
});

test("manifest paths are ignored/rejected and oversized metadata is bounded", async (t) => {
  const { store, root } = await fixture(t);
  const ref = await upload(store);
  const metadata = join(root, "objects", `${ref.ref.split("//")[1]}.json`);
  const original = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(metadata, JSON.stringify({ ...original, path: "/etc/passwd" }));
  await assert.rejects(store.resolve(ref.ref, "draft"));
  await writeFile(metadata, "x".repeat(16 * 1024 + 1));
  await assert.rejects(store.resolve(ref.ref, "draft"), /previewTooLarge/);
});

test("512 KiB chunks stream to disk and preserve UTF-8 across chunk boundaries", async (t) => {
  const { store, root } = await fixture(t);
  const bytes = Buffer.concat([
    Buffer.alloc(LIMITS.attachmentChunkMaxBytes - 1, 97),
    Buffer.from("🙂 tail"),
  ]);
  const ref = await upload(store, bytes);
  assert.deepEqual(await readdir(join(root, "staging")), []);
  const [input] = await store.toNativeInput([ref], "draft");
  assert.equal(input?.type, "text");
  if (input?.type === "text") assert.equal(input.text, bytes.toString());
});

test("staging capacity reserves declared bytes, abort releases capacity", async (t) => {
  const { store } = await fixture(t);
  const empty = Buffer.alloc(0);
  for (let i = 0; i < 3; i++)
    await begin(store, empty, {
      uploadId: `u-${i}`,
      totalBytes: LIMITS.attachmentMaxBytes,
      totalChunks: 40,
    });
  await assert.rejects(
    begin(store, empty, { totalBytes: LIMITS.attachmentMaxBytes, totalChunks: 40 }),
    /stagingCapacityExceeded/,
  );
  await store.handle(V4_METHODS.attachmentAbort, { ...common, uploadId: "u-0" });
  await begin(store, empty, { totalBytes: LIMITS.attachmentMaxBytes, totalChunks: 40 });
});

test("native text above 1 MiB fails explicitly rather than truncating or dropping", async (t) => {
  const { store } = await fixture(t);
  const ref = await upload(store, Buffer.alloc(1024 * 1024 + 1, 97));
  await assert.rejects(store.toNativeInput([ref], "draft"), /textInputLimit/);
});

test("bounded operation admission and close settle outstanding calls", async (t) => {
  const { store } = await fixture(t);
  const promises = Array.from({ length: 64 }, (_, i) =>
    begin(store, Buffer.alloc(0), { uploadId: `u-${i}` }).catch((error: Error) => error),
  );
  await assert.rejects(begin(store, Buffer.alloc(0)), /operationLimit/);
  await store.close();
  const outcomes = await Promise.all(promises);
  assert.equal(outcomes.filter((result) => result instanceof Error).length, 48);
});

test("row authorization cannot bypass ownership and missing content has a stable fault", async (t) => {
  const { store } = await fixture(t);
  const ref = await upload(store);
  const query = {
    ref: ref.ref,
    sessionId: "other",
    target: { rowId: 1, entityId: "entity" },
    attachmentIndex: 0,
  };
  await assert.rejects(
    store.handle(V4_METHODS.conversationAttachmentStat, query),
    /refNotAuthorized/,
  );
  const { path } = await store.resolve(ref.ref, "draft");
  await unlink(path);
  await assert.rejects(
    store.handle(V4_METHODS.conversationAttachmentStat, { ...query, sessionId: "draft" }),
    { code: "fault.attachment.shareStatNotFound" },
  );
});

test("stat is metadata-only and reports actual size without reading content", async (t) => {
  const { store } = await fixture(t);
  const ref = await upload(store);
  const { path } = await store.resolve(ref.ref, "draft");
  await writeFile(path, "changed content");
  const result = await store.handle(V4_METHODS.conversationAttachmentStat, {
    sessionId: "draft",
    ref: ref.ref,
    target: { rowId: 1, entityId: "entity" },
    attachmentIndex: 0,
  });
  assert.deepEqual(result, { mediaType: "text/plain", totalBytes: 15 });
  await assert.rejects(store.toNativeInput([ref], "draft"), /lengthMismatch/);
});
