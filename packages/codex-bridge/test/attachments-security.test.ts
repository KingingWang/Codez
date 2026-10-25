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
  v4ConversationAttachmentReadResultSchema,
} from "@codez/shared/codez-protocol-v4";
import { AttachmentStore } from "../src/attachments.js";
import { parseNativeFileReference } from "../src/native-file-reference.js";

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
  if (input?.type === "text") {
    const resolved = await store.resolve(ref.ref, "draft");
    assert.equal(parseNativeFileReference(input.text)?.path, resolved.path);
    assert.deepEqual(await readFile(resolved.path), bytes);
  }
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

test("native text above 1 MiB remains a complete readable file reference", async (t) => {
  const { store } = await fixture(t);
  const ref = await upload(store, Buffer.alloc(1024 * 1024 + 1, 97));
  const [input] = await store.toNativeInput([ref], "draft");
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected file reference");
  assert.equal(
    parseNativeFileReference(input.text)?.path,
    (await store.resolve(ref.ref, "draft")).path,
  );
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

test("缓存命中不放宽归属与行授权，并发预览不跨 session 复用结果", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codez attachment cache "));
  const root = join(cwd, "store");
  t.after(() => rm(cwd, { force: true, recursive: true }));
  let allowed = true;
  const store = new AttachmentStore({ cwd, root, authorizeRead: () => allowed });
  t.after(() => store.close());
  const bytes = Buffer.alloc(128 * 1024, 3);
  const ref = await upload(store, bytes);
  const target = { rowId: 1, entityId: "entity" };
  const preview = (sessionId: string, offset: number) =>
    store.handle(V4_METHODS.conversationAttachmentRead, {
      sessionId,
      ref: ref.ref,
      target,
      attachmentIndex: 0,
      offset,
      limit: 64,
    });
  const owner = v4ConversationAttachmentReadResultSchema.parse(await preview("draft", 0));
  assert.deepEqual(Buffer.from(owner.dataBase64, "base64"), bytes.subarray(0, 64));
  assert.equal(store.integrityVerificationCount, 1);

  // 并发：授权 session 与越权 session 同时读取同一 blob，越权方不得复用已验证结果。
  const [owned, denied] = await Promise.allSettled([preview("draft", 64), preview("other", 64)]);
  assert.equal(owned.status, "fulfilled");
  assert.equal(denied.status, "rejected");
  assert.match(String((denied as PromiseRejectedResult).reason), /refNotAuthorized/);
  assert.equal(store.integrityVerificationCount, 1);

  // 行授权被撤回后，缓存里那条「已验证」结论也不能继续放行预览。
  allowed = false;
  await assert.rejects(preview("draft", 0), /shareReadNotAuthorized/);
  await assert.rejects(
    store.handle(V4_METHODS.attachmentRead, {
      sessionId: "draft",
      ref: ref.ref,
      target,
      attachmentIndex: 0,
      offset: 0,
      limit: 64,
    }),
    /previewRefNotAuthorized/,
  );
  allowed = true;

  // 另一个 workspace 身份即使指向同一 root，也读不到本 workspace 的 blob。
  const otherWorkspace = new AttachmentStore({
    cwd: join(cwd, "other"),
    root,
    authorizeRead: () => true,
  });
  t.after(() => otherWorkspace.close());
  await assert.rejects(otherWorkspace.resolve(ref.ref, "draft"), /refNotAuthorized/);
  await assert.rejects(
    otherWorkspace.handle(V4_METHODS.conversationAttachmentRead, {
      sessionId: "draft",
      ref: ref.ref,
      target,
      attachmentIndex: 0,
      offset: 0,
      limit: 64,
    }),
    /refNotAuthorized/,
  );
  assert.equal(store.integrityVerificationCount, 1);
});

test(
  "已缓存的 blob 被改写、替换或链接后必须重新校验并 fail-closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, cwd } = await fixture(t);
    const bytes = Buffer.alloc(256 * 1024, 7);
    const ref = await upload(store, bytes);
    const preview = async (offset = 0) =>
      v4ConversationAttachmentReadResultSchema.parse(
        await store.handle(V4_METHODS.conversationAttachmentRead, {
          sessionId: "draft",
          ref: ref.ref,
          target: { rowId: 1, entityId: "entity" },
          attachmentIndex: 0,
          offset,
          limit: 64,
        }),
      );
    const first = await preview();
    assert.deepEqual(Buffer.from(first.dataBase64, "base64"), bytes.subarray(0, 64));
    assert.equal(store.integrityVerificationCount, 1);
    const { path } = await store.resolve(ref.ref, "draft");
    assert.equal(store.integrityVerificationCount, 1);

    // 等长原地改写可能与上一次校验落在同一个粗粒度时间戳刻度内（本机 overlayfs 实测 4ms），
    // (dev, ino, size, mtimeMs, ctimeMs) 完全相同；必须由有界采样复验发现，
    // 否则改写后的字节会被当成已验证内容返回。
    await writeFile(path, Buffer.alloc(bytes.length, 9));
    await assert.rejects(preview(), /checksumMismatch/);
    assert.equal(store.integrityVerificationCount, 2);
    // 校验失败即清除记录：下一次读取仍然完整校验，不会因为失败而缓存「已验证」。
    await assert.rejects(preview(), /checksumMismatch/);
    assert.equal(store.integrityVerificationCount, 3);

    // 长度变化在打开阶段就被「磁盘长度 == manifest 声明长度」拦下，不消耗完整校验。
    await writeFile(path, "short");
    await assert.rejects(preview(), /lengthMismatch/);
    assert.equal(store.integrityVerificationCount, 3);

    // 恢复原内容后缓存重新变热，随后的链接替换必须在文件身份校验阶段被拒绝。
    await writeFile(path, bytes);
    assert.deepEqual(Buffer.from((await preview()).dataBase64, "base64"), bytes.subarray(0, 64));
    assert.equal(store.integrityVerificationCount, 4);

    const outside = join(cwd, "outside");
    await writeFile(outside, bytes);
    await unlink(path);
    await symlink(outside, path);
    await assert.rejects(preview(), /unsafeStoragePath/);
    await unlink(path);
    await link(outside, path);
    await assert.rejects(preview(), /unsafeStoragePath/);
    // 身份校验失败发生在完整校验之前，计数不变。
    assert.equal(store.integrityVerificationCount, 4);
    // 链接指向的外部文件既没有被读取，也没有被改写。
    assert.deepEqual(await readFile(outside), bytes);
  },
);
