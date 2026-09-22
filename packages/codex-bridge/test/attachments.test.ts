import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  PROTOCOL_V4_LIMITS as LIMITS,
  V4_METHODS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentAbortResultSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatResultSchema,
  type AttachmentRef,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentStore, type AttachmentStoreOptions } from "../src/attachments.js";

const checksum = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const common = { connectionId: "connection", sessionId: "draft-session", uploadId: "upload" };
const target = { rowId: 1, entityId: "entity" };
async function fixture(t: TestContext, overrides: Partial<AttachmentStoreOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "zcode attachments 中文 "));
  const root = join(cwd, "storage");
  const store = new AttachmentStore({ cwd, root, ...overrides });
  t.after(async () => {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { store, root, cwd };
}
function begin(bytes = Buffer.from("hello"), extra = {}) {
  return {
    ...common,
    fileName: "note.txt",
    mime: "text/plain",
    totalBytes: bytes.length,
    totalChunks: bytes.length ? 1 : 0,
    checksum: checksum(bytes),
    ...extra,
  };
}
async function put(
  store: AttachmentStore,
  bytes = Buffer.from("hello"),
  extra = {},
): Promise<AttachmentRef> {
  const params = begin(bytes, extra);
  await store.handle(V4_METHODS.attachmentBegin, params);
  if (bytes.length)
    await store.handle(V4_METHODS.attachmentChunk, {
      connectionId: params.connectionId,
      sessionId: params.sessionId,
      uploadId: params.uploadId,
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    });
  const { ref } = v4AttachmentCommitResultSchema.parse(
    await store.handle(V4_METHODS.attachmentCommit, {
      connectionId: params.connectionId,
      sessionId: params.sessionId,
      uploadId: params.uploadId,
    }),
  );
  return { ref, fileName: params.fileName, mime: params.mime, bytes: bytes.length };
}

test("draft-session upload produces opaque owned refs and UTF-8 native text", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("你好🙂 attachment");
  const ref = await put(store, bytes, { fileName: "../../outside.txt" });
  assert.match(ref.ref, /^zcode-attachment:\/\//);
  const resolved = await store.resolve(ref.ref, common.sessionId);
  assert.equal(resolved.fileName, "../../outside.txt");
  assert.equal(resolved.bytes, bytes.length);
  assert.equal(resolved.checksum, checksum(bytes));
  assert.deepEqual(await readFile(resolved.path), bytes);
  assert.deepEqual(await store.toNativeInput([ref], common.sessionId), [
    { type: "text", text: bytes.toString(), text_elements: [] },
  ]);
  await assert.rejects(store.resolve(ref.ref, "other-session"), /[Aa]uthorized|[Oo]wner/);
  await assert.rejects(store.toNativeInput([ref], "other-session"));
});

test("image input uses stored metadata and a trusted local file", async (t) => {
  const { store } = await fixture(t);
  const ref = await put(store, Buffer.from([137, 80, 78, 71]), {
    mime: "image/png",
    fileName: "a.png",
  });
  const resolved = await store.resolve(ref.ref, common.sessionId);
  assert.deepEqual(await store.toNativeInput([{ ...ref, mime: "text/plain" }], common.sessionId), [
    { type: "localImage", path: resolved.path },
  ]);
});

test("begin/chunk/commit retries are idempotent with ordered concurrent chunks", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("abcdef");
  const metadata = begin(bytes, { totalChunks: 2 });
  const started = await store.handle(V4_METHODS.attachmentBegin, metadata);
  assert.deepEqual(v4AttachmentBeginResultSchema.parse(started), {
    uploadId: "upload",
    state: "staging",
    nextChunkIndex: 0,
  });
  const chunk = { ...common, chunkIndex: 0, dataBase64: Buffer.from("abc").toString("base64") };
  const next = { ...common, chunkIndex: 1, dataBase64: Buffer.from("def").toString("base64") };
  const results = await Promise.all([
    store.handle(V4_METHODS.attachmentChunk, chunk),
    store.handle(V4_METHODS.attachmentChunk, next),
  ]);
  assert.equal(v4AttachmentChunkResultSchema.parse(results[1]).nextChunkIndex, 2);
  assert.deepEqual(await store.handle(V4_METHODS.attachmentChunk, chunk), results[1]);
  assert.equal(
    v4AttachmentBeginResultSchema.parse(await store.handle(V4_METHODS.attachmentBegin, metadata))
      .nextChunkIndex,
    2,
  );
  const [a, b] = await Promise.all([
    store.handle(V4_METHODS.attachmentCommit, common),
    store.handle(V4_METHODS.attachmentCommit, common),
  ]);
  assert.deepEqual(a, b);
  assert.equal(
    v4AttachmentBeginResultSchema.parse(await store.handle(V4_METHODS.attachmentBegin, metadata))
      .state,
    "committed",
  );
  await assert.rejects(
    store.handle(V4_METHODS.attachmentBegin, { ...metadata, mime: "image/png" }),
    /beginConflict/,
  );
});

test("rejects gaps, conflicting retries, excess bytes, empty chunks and incomplete commit", async (t) => {
  const { store } = await fixture(t);
  await store.handle(V4_METHODS.attachmentBegin, begin(Buffer.from("abc"), { totalChunks: 2 }));
  const chunk = { ...common, chunkIndex: 0, dataBase64: "YQ==" };
  await assert.rejects(
    store.handle(V4_METHODS.attachmentChunk, { ...chunk, chunkIndex: 1 }),
    /chunkGap/,
  );
  await assert.rejects(
    store.handle(V4_METHODS.attachmentChunk, { ...chunk, dataBase64: "" }),
    /emptyChunk/,
  );
  await store.handle(V4_METHODS.attachmentChunk, chunk);
  await assert.rejects(
    store.handle(V4_METHODS.attachmentChunk, { ...chunk, dataBase64: "Yg==" }),
    /chunkConflict/,
  );
  await assert.rejects(
    store.handle(V4_METHODS.attachmentChunk, { ...chunk, chunkIndex: 1, dataBase64: "eHl6" }),
    /totalBytesExceeded/,
  );
  await assert.rejects(store.handle(V4_METHODS.attachmentCommit, common), /uploadIncomplete/);
  await assert.rejects(
    store.handle(V4_METHODS.attachmentBegin, begin(Buffer.from("x"))),
    /beginConflict/,
  );
});

test("checksum mismatch cannot commit and abort removes staged bytes", async (t) => {
  const { store, root } = await fixture(t);
  await store.handle(V4_METHODS.attachmentBegin, begin(Buffer.from("abc")));
  await store.handle(V4_METHODS.attachmentChunk, { ...common, chunkIndex: 0, dataBase64: "YWJk" });
  await assert.rejects(store.handle(V4_METHODS.attachmentCommit, common), /checksumMismatch/);
  assert.equal((await readdir(join(root, "staging"))).length, 1);
  assert.deepEqual(
    v4AttachmentAbortResultSchema.parse(await store.handle(V4_METHODS.attachmentAbort, common)),
    {},
  );
  assert.deepEqual(await readdir(join(root, "staging")), []);
  await store.handle(V4_METHODS.attachmentAbort, common);
  await assert.rejects(store.handle(V4_METHODS.attachmentCommit, common), /uploadNotFound/);
});

test("zero-byte uploads commit without chunks and survive a new store instance", async (t) => {
  const { store, cwd, root } = await fixture(t);
  const ref = await put(store, Buffer.alloc(0));
  await store.close();
  const restarted = new AttachmentStore({ cwd, root });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.toNativeInput([ref], common.sessionId), [
    { type: "text", text: "", text_elements: [] },
  ]);
  const otherWorkspace = new AttachmentStore({ cwd: join(cwd, "other"), root });
  t.after(() => otherWorkspace.close());
  await assert.rejects(otherWorkspace.resolve(ref.ref, common.sessionId), /[Aa]uthorized|[Oo]wner/);
});

test("scope tuple isolates connections/sessions, including delimiter-shaped identifiers", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("a");
  const a = { ...common, connectionId: "a\0b", sessionId: "c" };
  const b = { ...common, connectionId: "a", sessionId: "b\0c" };
  await store.handle(V4_METHODS.attachmentBegin, begin(bytes, a));
  await assert.rejects(
    store.handle(V4_METHODS.attachmentChunk, { ...b, chunkIndex: 0, dataBase64: "YQ==" }),
    /uploadNotFound/,
  );
  await store.handle(V4_METHODS.attachmentBegin, begin(bytes, b));
  await store.handle(V4_METHODS.attachmentAbort, a);
  await store.handle(V4_METHODS.attachmentChunk, { ...b, chunkIndex: 0, dataBase64: "YQ==" });
  await store.handle(V4_METHODS.attachmentCommit, b);
});

test("staging count, TTL and close are bounded and clean up", async (t) => {
  let now = 0;
  const { store, root } = await fixture(t, { now: () => now });
  for (let i = 0; i < LIMITS.attachmentUploadMaxConcurrent; i++) {
    await store.handle(
      V4_METHODS.attachmentBegin,
      begin(Buffer.from("a"), { uploadId: `upload-${i}` }),
    );
  }
  await assert.rejects(store.handle(V4_METHODS.attachmentBegin, begin()), /tooManyUploads/);
  now += LIMITS.attachmentUploadTtlMs + 1;
  await store.handle(V4_METHODS.attachmentBegin, begin());
  assert.equal((await readdir(join(root, "staging"))).length, 1);
  await store.close();
  assert.deepEqual(await readdir(join(root, "staging")), []);
  await assert.rejects(store.handle(V4_METHODS.attachmentBegin, begin()), /closed/);
});

test("shared schemas enforce base64, chunk size, metadata and method allowlist", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.handle(V4_METHODS.attachmentBegin, begin(Buffer.from("a"), { totalChunks: 0 })),
  );
  await assert.rejects(
    store.handle(V4_METHODS.attachmentBegin, begin(Buffer.from("a"), { uploadId: "../../x" })),
  );
  await assert.rejects(
    store.handle(
      V4_METHODS.attachmentBegin,
      begin(Buffer.from("a"), { totalBytes: LIMITS.attachmentChunkMaxBytes + 1 }),
    ),
    /chunkCountInsufficient/,
  );
  await store.handle(V4_METHODS.attachmentBegin, begin());
  for (const dataBase64 of [
    "!!!!",
    "a",
    Buffer.alloc(LIMITS.attachmentChunkMaxBytes + 1).toString("base64"),
  ]) {
    await assert.rejects(
      store.handle(V4_METHODS.attachmentChunk, { ...common, chunkIndex: 0, dataBase64 }),
    );
  }
  await assert.rejects(store.handle("v4/attachment/put", {}), /[Uu]nsupported/);
});

test("preview/share read/stat require row authorization on every request", async (t) => {
  let allowed = false;
  const queries: unknown[] = [];
  const { store } = await fixture(t, {
    authorizeRead: (query) => {
      queries.push(query);
      return allowed;
    },
  });
  const ref = await put(store, Buffer.from("image"), { mime: "image/png" });
  const query = { sessionId: common.sessionId, ref: ref.ref, target, attachmentIndex: 0 };
  await assert.rejects(
    store.handle(V4_METHODS.attachmentRead, { ...query, offset: 0, limit: 2 }),
    /[Aa]uthorized/,
  );
  allowed = true;
  const first = v4AttachmentReadResultSchema.parse(
    await store.handle(V4_METHODS.attachmentRead, { ...query, offset: 0, limit: 2 }),
  );
  assert.deepEqual(first, {
    dataBase64: "aW0=",
    mediaType: "image/png",
    totalBytes: 5,
    nextOffset: 2,
  });
  const last = v4ConversationAttachmentReadResultSchema.parse(
    await store.handle(V4_METHODS.conversationAttachmentRead, { ...query, offset: 2, limit: 10 }),
  );
  assert.equal(last.nextOffset, null);
  assert.equal(Buffer.from(last.dataBase64, "base64").toString(), "age");
  const stat = v4ConversationAttachmentStatResultSchema.parse(
    await store.handle(V4_METHODS.conversationAttachmentStat, query),
  );
  assert.equal(stat.totalBytes, 5);
  assert.equal(stat.mediaType, "image/png");
  assert.equal(queries.length, 4);
  allowed = false;
  await assert.rejects(
    store.handle(V4_METHODS.conversationAttachmentStat, query),
    /shareStatNotAuthorized/,
  );
});

test("missing row hook denies read; authorized text share is not media preview", async (t) => {
  const { store, cwd, root } = await fixture(t);
  const ref = await put(store);
  const query = { sessionId: common.sessionId, ref: ref.ref, target, attachmentIndex: 0 };
  await assert.rejects(
    store.handle(V4_METHODS.attachmentRead, { ...query, offset: 0, limit: 3 }),
    /[Aa]uthorized/,
  );
  const reader = new AttachmentStore({ cwd, root, authorizeRead: () => true });
  t.after(() => reader.close());
  await assert.rejects(
    reader.handle(V4_METHODS.attachmentRead, { ...query, offset: 0, limit: 3 }),
    /previewNotMedia/,
  );
  await assert.rejects(
    reader.handle(V4_METHODS.conversationAttachmentRead, { ...query, offset: 6, limit: 3 }),
    /previewRangeInvalid/,
  );
  const result = v4ConversationAttachmentReadResultSchema.parse(
    await reader.handle(V4_METHODS.conversationAttachmentRead, { ...query, offset: 5, limit: 3 }),
  );
  assert.equal(result.dataBase64, "");
  assert.equal(result.nextOffset, null);
  await assert.rejects(
    reader.handle(V4_METHODS.attachmentRead, { ...query, target: undefined, offset: 0, limit: 3 }),
  );
});

for (const mime of ["video/mp4", "audio/wav", "application/pdf", "application/octet-stream"]) {
  test(`${mime} is an explicit native-input error, never silently omitted`, async (t) => {
    const { store } = await fixture(t);
    const ref = await put(store, Buffer.from("payload"), { mime });
    await assert.rejects(
      store.toNativeInput([{ ...ref, mime: "text/plain" }], common.sessionId),
      /nativeTypeUnsupported/,
    );
  });
}

test("invalid UTF-8 text fails explicitly and native input array is bounded", async (t) => {
  const { store } = await fixture(t);
  const ref = await put(store, Buffer.from([0xc3, 0x28]));
  await assert.rejects(store.toNativeInput([ref], common.sessionId), /invalidUtf8/);
  await assert.rejects(
    store.toNativeInput(
      Array.from({ length: 65 }, () => ref),
      common.sessionId,
    ),
    /[Ll]imit/,
  );
  assert.deepEqual(await store.toNativeInput(undefined, common.sessionId), []);
});
