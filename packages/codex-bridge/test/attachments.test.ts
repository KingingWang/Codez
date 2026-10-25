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
} from "@codez/shared/codez-protocol-v4";
import { AttachmentStore, type AttachmentStoreOptions } from "../src/attachments.js";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { replaceQueuedText } from "../src/command-input.js";
import type { CodexRpcPort } from "../src/contract.js";
import { InteractionBroker } from "../src/interactions.js";
import { projectOwnedInput } from "../src/native-file-projection.js";
import {
  extractNativeFileReferences,
  formatNativeInlineFileReference,
  parseNativeFileReference,
} from "../src/native-file-reference.js";
import { ThreadStateStore } from "../src/thread-state.js";
import { threadFixture } from "./projection-fixtures.test.js";

const checksum = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const common = { connectionId: "connection", sessionId: "draft-session", uploadId: "upload" };
const target = { rowId: 1, entityId: "entity" };
async function fixture(t: TestContext, overrides: Partial<AttachmentStoreOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "codez attachments 中文 "));
  const root = join(cwd, "storage");
  const store = new AttachmentStore({ cwd, root, ...overrides });
  t.after(async () => {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { store, root, cwd };
}
function begin(bytes: Buffer = Buffer.from("hello"), extra = {}) {
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

/** 按 512 KiB 分块上传大附件，用于分页预览测试。 */
async function putLarge(store: AttachmentStore, bytes: Buffer, extra = {}): Promise<AttachmentRef> {
  const chunk = LIMITS.attachmentChunkMaxBytes;
  const params = begin(bytes, { totalChunks: Math.ceil(bytes.length / chunk), ...extra });
  await store.handle(V4_METHODS.attachmentBegin, params);
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunk, index++)
    await store.handle(V4_METHODS.attachmentChunk, {
      connectionId: params.connectionId,
      sessionId: params.sessionId,
      uploadId: params.uploadId,
      chunkIndex: index,
      dataBase64: bytes.subarray(offset, offset + chunk).toString("base64"),
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test("draft-session upload produces opaque owned refs and UTF-8 native text", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("你好🙂 attachment");
  const ref = await put(store, bytes, { fileName: "../../outside.txt" });
  assert.match(ref.ref, /^codez-attachment:\/\//);
  const resolved = await store.resolve(ref.ref, common.sessionId);
  assert.equal(resolved.fileName, "../../outside.txt");
  assert.equal(resolved.bytes, bytes.length);
  assert.equal(resolved.checksum, checksum(bytes));
  assert.deepEqual(await readFile(resolved.path), bytes);
  const [input] = await store.toNativeInput([ref], common.sessionId);
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected inline file");
  assert.ok(input.text.includes(bytes.toString()));
  assert.equal(extractNativeFileReferences(input.text)[0]?.attachment.ref, ref.ref);
  assert.deepEqual(await projectOwnedInput([input], common.sessionId, store), {
    text: "",
    refs: [ref],
  });
  await assert.rejects(store.resolve(ref.ref, "other-session"), /[Aa]uthorized|[Oo]wner/);
  await assert.rejects(store.toNativeInput([ref], "other-session"));
});

test("native file references keep complete oversized text and binary bytes tool-readable", async (t) => {
  const { store } = await fixture(t);
  for (const [index, bytes, fileName, mime] of [
    [0, Buffer.from("a".repeat(64 * 1024 + 1)), "long.html", "text/html"],
    [1, Buffer.from([0x50, 0x4b, 0x03, 0x04]), "sample.zip", "application/zip"],
  ] as const) {
    const ref = await put(store, bytes, { uploadId: `file-${index}`, fileName, mime });
    const input = await store.toNativeInput([ref], common.sessionId);
    assert.equal(input.length, 1);
    assert.equal(input[0]?.type, "text");
    if (input[0]?.type !== "text") throw new Error("Expected file reference");
    const resolved = await store.resolve(ref.ref, common.sessionId);
    // 原生说明会 JSON 转义 Windows 反斜杠；校验解码后的路径，不能匹配原始文本。
    assert.equal(parseNativeFileReference(input[0].text)?.path, resolved.path);
    assert.ok(!input[0].text.includes("a".repeat(64 * 1024)));
    assert.deepEqual(await readFile(resolved.path), bytes);
  }
});

test("clipboard text is deferred even when small, while regular text is complete", async (t) => {
  const { store } = await fixture(t);
  const ref = await put(store, Buffer.from("small"), { uploadId: "clipboard" });
  const [input] = await store.toNativeInput(
    [{ ...ref, sourceKind: "clipboard-text" }],
    common.sessionId,
  );
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected file reference");
  assert.notEqual(input.text, "small");
  assert.match(input.text, /small|note\.txt|codez-attachment/u);
  const [regular] = await store.toNativeInput([ref], common.sessionId);
  assert.equal(regular?.type, "text");
  if (regular?.type !== "text") throw new Error("Expected inline text");
  assert.ok(regular.text.includes("small"));
  assert.equal(extractNativeFileReferences(regular.text)[0]?.inlineText, "small");
});

test("native aggregate text budget defers whole later files rather than rejecting or clipping", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("文".repeat(50 * 1024));
  const refs = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      put(store, bytes, { uploadId: `aggregate-${index}`, fileName: `${index}.txt` }),
    ),
  );
  const inputs = await store.toNativeInput(refs, common.sessionId);
  assert.equal(inputs.length, 8);
  for (const [index, input] of inputs.entries()) {
    assert.equal(input.type, "text");
    if (input.type !== "text") continue;
    if (index < 6)
      assert.equal(extractNativeFileReferences(input.text)[0]?.inlineText, bytes.toString());
    else assert.equal(parseNativeFileReference(input.text)?.attachment.ref, refs[index]?.ref);
  }
  const edited = await replaceQueuedText(
    [{ id: "queued", input: inputs }],
    "queued",
    "updated prompt",
    common.sessionId,
    (attachments, id) => store.toNativeInput(attachments, id),
  );
  assert.deepEqual(edited.slice(1), inputs);
});

test("small text survives queue edit, merged native text and a fresh bridge projection", async (t) => {
  const { store, cwd, root } = await fixture(t);
  const ref = await put(store, Buffer.from("full\ntext"), { uploadId: "small-inline" });
  const [file] = await store.toNativeInput([ref], common.sessionId);
  assert.equal(file?.type, "text");
  if (file?.type !== "text") throw new Error("Expected inline file");
  const edited = await replaceQueuedText(
    [{ id: "queued", input: [{ type: "text", text: `old\n${file.text}\nafter` }] }],
    "queued",
    "new",
    common.sessionId,
    (attachments, id) => store.toNativeInput(attachments, id),
  );
  assert.deepEqual(edited, [{ type: "text", text: "new", text_elements: [] }, file]);
  await store.close();
  const restarted = new AttachmentStore({ cwd, root });
  t.after(() => restarted.close());
  assert.deepEqual(
    await projectOwnedInput(edited as (typeof file)[], common.sessionId, restarted),
    {
      text: "new",
      refs: [ref],
    },
  );
  assert.deepEqual(
    await projectOwnedInput(
      [{ type: "text", text: `new\n${file.text}\nafter`, text_elements: [] }],
      common.sessionId,
      restarted,
    ),
    { text: "new\n\nafter", refs: [ref] },
  );
  await assert.rejects(
    replaceQueuedText(
      [{ id: "queued", input: [file] }],
      "queued",
      "new",
      "another-session",
      (attachments, id) => restarted.toNativeInput(attachments, id),
    ),
  );
  const modified = file.text.replace("full\ntext", "fake\ntext");
  assert.deepEqual(extractNativeFileReferences(modified), []);
  const forged = formatNativeInlineFileReference({
    attachment: ref,
    path: (await restarted.resolve(ref.ref, common.sessionId)).path,
    text: "fake\ntext",
  });
  assert.deepEqual(
    (
      await projectOwnedInput(
        [{ type: "text", text: forged, text_elements: [] }],
        common.sessionId,
        restarted,
      )
    ).refs,
    [],
  );
});

test("multiple inline files above the UI row budget still project into history and queue", async (t) => {
  const { store, cwd } = await fixture(t);
  const thread = threadFixture();
  const bytes = Buffer.from("文".repeat(50 * 1024));
  const refs = await Promise.all(
    [0, 1].map((index) =>
      put(store, bytes, {
        sessionId: thread.id,
        uploadId: `snapshot-${index}`,
        fileName: `${index}.txt`,
      }),
    ),
  );
  const inputs = await store.toNativeInput(refs, thread.id);
  thread.turns[0]!.items[0] = {
    type: "userMessage",
    id: "user-1",
    content: [{ type: "text", text: "Inspect both", text_elements: [] }, ...inputs],
  };
  const rpc: CodexRpcPort = {
    async request() {
      throw new Error("unexpected native RPC");
    },
    async respond() {},
    async respondError() {},
  };
  const stateStore = new ThreadStateStore(rpc, cwd);
  const state = stateStore.markStarted(thread);
  state.queue = [{ id: "queued", clientUserMessageId: "command-1", input: inputs }];
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    stateStore,
    new InteractionBroker(rpc, () => {}),
    cwd,
    store,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const user = snapshot.rows.window.find((row) => row.kind === "userInput");
  assert.equal(user?.text, "Inspect both");
  assert.deepEqual(user?.attachments, refs);
  assert.equal(snapshot.queue.items[0]?.text, "");
  assert.deepEqual(snapshot.queue.items[0]?.attachments, refs);
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
  const [input] = await restarted.toNativeInput([ref], common.sessionId);
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected empty file reference");
  assert.equal(parseNativeFileReference(input.text)?.attachment.ref, ref.ref);
  assert.deepEqual(await projectOwnedInput([input], common.sessionId, restarted), {
    text: "",
    refs: [ref],
  });
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
  test(`${mime} is a complete native file reference, never silently omitted`, async (t) => {
    const { store } = await fixture(t);
    const ref = await put(store, Buffer.from("payload"), { mime, fileName: "sample.bin" });
    const [input] = await store.toNativeInput([{ ...ref, mime: "text/plain" }], common.sessionId);
    assert.equal(input?.type, "text");
    if (input?.type !== "text") throw new Error("Expected file reference");
    assert.equal(
      parseNativeFileReference(input.text)?.path,
      (await store.resolve(ref.ref, common.sessionId)).path,
    );
  });
}

test("invalid UTF-8 text remains file-readable and native input array is bounded", async (t) => {
  const { store } = await fixture(t);
  const ref = await put(store, Buffer.from([0xc3, 0x28]));
  const [input] = await store.toNativeInput([ref], common.sessionId);
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected file reference");
  assert.equal(
    parseNativeFileReference(input.text)?.path,
    (await store.resolve(ref.ref, common.sessionId)).path,
  );
  await assert.rejects(
    store.toNativeInput(
      Array.from({ length: 65 }, () => ref),
      common.sessionId,
    ),
    /[Ll]imit/,
  );
  assert.deepEqual(await store.toNativeInput(undefined, common.sessionId), []);
});

test("a ZIP with a false text MIME and .txt suffix is never inlined", async (t) => {
  const { store } = await fixture(t);
  const ref = await put(store, Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
    fileName: "mislabelled.txt",
    mime: "text/plain",
  });
  const [input] = await store.toNativeInput([ref], common.sessionId);
  assert.equal(input?.type, "text");
  if (input?.type !== "text") throw new Error("Expected path reference");
  assert.equal(parseNativeFileReference(input.text)?.attachment.ref, ref.ref);
  assert.equal(extractNativeFileReferences(input.text)[0]?.inlineText, undefined);
});

test("大附件连续分页预览只完整校验一次，20 页拼回原文", async (t) => {
  const { store } = await fixture(t, { authorizeRead: () => true });
  const pageSize = 64 * 1024;
  const pages = 20;
  const bytes = Buffer.alloc(pageSize * pages);
  // 确定性但每页不同的内容：任何一页错位或复用都会被拼回比对发现。
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) & 0xff;
  const media = { mime: "video/mp4", fileName: "big.mp4" };
  const ref = await putLarge(store, bytes, { ...media, uploadId: "paged" });
  const query = { sessionId: common.sessionId, ref: ref.ref, target, attachmentIndex: 0 };
  const page = (offset: number) =>
    store.handle(V4_METHODS.attachmentRead, { ...query, offset, limit: pageSize });
  const before = store.integrityVerificationCount;
  const received: Buffer[] = [];
  for (let index = 0; index < pages; index++) {
    const result = v4AttachmentReadResultSchema.parse(await page(index * pageSize));
    assert.equal(result.totalBytes, bytes.length);
    assert.equal(result.nextOffset, index + 1 < pages ? (index + 1) * pageSize : null);
    received.push(Buffer.from(result.dataBase64, "base64"));
  }
  assert.deepEqual(Buffer.concat(received), bytes);
  // 原因：blob 不可变，20 页只应触发一次完整 SHA-256；后续分页靠身份缓存 + 有界采样复验。
  assert.equal(store.integrityVerificationCount - before, 1);

  // 冷缓存下的并发分页必须按文件身份合并 in-flight 校验，而不是每页各算一次。
  const cold = await putLarge(store, bytes, { ...media, fileName: "cold.mp4", uploadId: "cold" });
  const coldBefore = store.integrityVerificationCount;
  const coldPages = await Promise.all(
    Array.from({ length: pages }, async (_, index) =>
      v4AttachmentReadResultSchema.parse(
        await store.handle(V4_METHODS.attachmentRead, {
          ...query,
          ref: cold.ref,
          offset: index * pageSize,
          limit: pageSize,
        }),
      ),
    ),
  );
  assert.equal(store.integrityVerificationCount - coldBefore, 1);
  assert.deepEqual(
    Buffer.concat(coldPages.map((result) => Buffer.from(result.dataBase64, "base64"))),
    bytes,
  );
});

test("只读预览并发执行并共享总在途上限", { timeout: 30_000 }, async (t) => {
  let arrivals = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const { store } = await fixture(t, {
    authorizeRead: async () => {
      arrivals += 1;
      await gate;
      return true;
    },
  });
  const bytes = Buffer.from("preview");
  const ref = await put(store, bytes, { mime: "image/png", fileName: "p.png" });
  const read = (offset: number) =>
    store.handle(V4_METHODS.attachmentRead, {
      sessionId: common.sessionId,
      ref: ref.ref,
      target,
      attachmentIndex: 0,
      offset,
      limit: 1,
    });
  const reads = Array.from({ length: 64 }, (_, index) => read(index % bytes.length));
  try {
    // 串行实现下第 2 个预览永远进不到 authorizeRead，这里会超时失败。
    for (let waited = 0; waited < 5_000 && arrivals < 64; waited++) await tick();
    assert.equal(arrivals, 64);
    await assert.rejects(read(0), /operationLimit/);
    await assert.rejects(
      store.handle(V4_METHODS.attachmentBegin, begin(Buffer.alloc(0), { uploadId: "blocked" })),
      /operationLimit/,
    );
  } finally {
    open();
  }
  const results = await Promise.all(reads);
  for (const result of results)
    assert.equal(v4AttachmentReadResultSchema.parse(result).totalBytes, bytes.length);
  // 释放后写队列恢复可用：admission 上限只约束在途操作，不是永久熔断。
  await store.handle(V4_METHODS.attachmentBegin, begin(Buffer.alloc(0), { uploadId: "after" }));
});
