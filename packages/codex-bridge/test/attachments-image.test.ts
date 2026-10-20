import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
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

const sessionId = "image-thread";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const url = `data:image/png;base64,${png.toString("base64")}`;

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "codez image lookup "));
  const root = join(cwd, "attachments");
  const stores: AttachmentStore[] = [];
  const create = (options = { cwd, root }) => {
    const store = new AttachmentStore(options);
    stores.push(store);
    return store;
  };
  const store = create();
  t.after(async () => {
    for (const instance of stores) await instance.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { store, create, cwd, root };
}

async function upload(store: AttachmentStore, owner = sessionId, mime = "image/png") {
  const scope = { sessionId: owner, connectionId: "connection", uploadId: randomUUID() };
  await store.handle(V4_METHODS.attachmentBegin, {
    ...scope,
    fileName: "照片.png",
    mime,
    totalBytes: png.length,
    totalChunks: 1,
    checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
  });
  await store.handle(V4_METHODS.attachmentChunk, {
    ...scope,
    chunkIndex: 0,
    dataBase64: png.toString("base64"),
  });
  const { ref } = v4AttachmentCommitResultSchema.parse(
    await store.handle(V4_METHODS.attachmentCommit, scope),
  );
  const { path } = await store.resolve(ref, owner);
  return { attachment: { ref, fileName: "照片.png", mime, bytes: png.length }, path };
}

test("native data image recovers an existing manifest across restart without authorizing a row", async (t) => {
  const { store, create } = await fixture(t);
  const { attachment } = await upload(store);
  assert.deepEqual(await store.findNativeImageAttachment(url, sessionId), attachment);
  await store.close();
  const restarted = create();
  assert.deepEqual(await restarted.findNativeImageAttachment(url, sessionId), attachment);
  await assert.rejects(
    restarted.handle(V4_METHODS.attachmentRead, {
      sessionId,
      ref: attachment.ref,
      offset: 0,
      limit: png.length,
    }),
    /previewRefNotAuthorized/,
  );
});

test("image lookup isolates session, draft, workspace and store", async (t) => {
  const { store, create, cwd, root } = await fixture(t);
  const { attachment } = await upload(store, "draft-thread");
  const copied = await store.findNativeImageAttachment(url, sessionId);
  assert.ok(copied && copied.ref !== attachment.ref);
  await assert.rejects(store.resolve(attachment.ref, sessionId), /refNotAuthorized/);
  assert.deepEqual(await store.findNativeImageAttachment(url, "draft-thread"), attachment);
  const workspaceCopy = await create({ cwd: join(cwd, "other"), root }).findNativeImageAttachment(
    url,
    "draft-thread",
  );
  assert.ok(workspaceCopy && workspaceCopy.ref !== attachment.ref);
  const rootCopy = await create({ cwd, root: join(cwd, "other-store") }).findNativeImageAttachment(
    url,
    "draft-thread",
  );
  assert.ok(rootCopy && rootCopy.ref !== attachment.ref);
});

test("malformed, non-image, noncanonical and oversized URLs never access storage", async (t) => {
  const { store, root } = await fixture(t);
  const invalid = [
    "",
    "/etc/passwd",
    "file:///etc/passwd",
    "https://example.invalid/image.png",
    "data:text/plain;base64,YQ==",
    "data:image/png,hello",
    "data:image/png;base64,",
    "data:image/png;base64,YQ",
    "data:image/png;base64,YR==",
    "data:image/png;base64,YQ==\n",
    "data:image/png;base64,Y!Q==",
    "data:image/png;foo=bar;base64,YQ==",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/../../evil;base64,YQ==",
    "data:image/avif;base64,YQ==",
    `data:image/${"x".repeat(256)};base64,YQ==`,
    `data:image/png;base64,${"A".repeat(4 * Math.ceil(LIMITS.attachmentMaxBytes / 3) + 4)}`,
  ];
  for (const value of invalid)
    assert.equal(await store.findNativeImageAttachment(value, sessionId), undefined);
  assert.equal(await store.findNativeImageAttachment(url, ""), undefined);
  assert.equal(await store.findNativeImageAttachment(url, "x".repeat(1025)), undefined);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("decoded content uses persisted image MIME and never reuses a text ref", async (t) => {
  const { store } = await fixture(t);
  const text = await upload(store, sessionId, "text/plain");
  const attachment = await store.findNativeImageAttachment(url, sessionId);
  assert.ok(attachment && attachment.ref !== text.attachment.ref);
  assert.deepEqual(
    await store.findNativeImageAttachment(url.replace("image/png", "image/jpeg"), sessionId),
    attachment,
  );
  const changed = Buffer.from(png);
  changed.writeUInt8(changed.readUInt8(0) ^ 1, 0);
  const derived = await store.findNativeImageAttachment(
    `data:image/png;base64,${changed.toString("base64")}`,
    sessionId,
  );
  assert.ok(derived && derived.ref !== attachment.ref);
  assert.deepEqual(await readFile((await store.resolve(derived.ref, sessionId)).path), changed);
});

test("duplicate images use a stable ref, recheck deletion and see later uploads", async (t) => {
  const { store, create } = await fixture(t);
  const uploaded = [await upload(store), await upload(store)];
  uploaded.sort((a, b) => a.attachment.ref.localeCompare(b.attachment.ref));
  const [first, second] = uploaded;
  assert.ok(first && second);
  const restarted = create();
  assert.deepEqual(await restarted.findNativeImageAttachment(url, sessionId), first.attachment);
  await unlink(first.path);
  assert.deepEqual(await restarted.findNativeImageAttachment(url, sessionId), second.attachment);
  await unlink(second.path.replace(/\.data$/, ".json"));
  const restored = await restarted.findNativeImageAttachment(url, sessionId);
  assert.ok(
    restored && restored.ref !== first.attachment.ref && restored.ref !== second.attachment.ref,
  );
  await unlink((await restarted.resolve(restored.ref, sessionId)).path.replace(/\.data$/, ".json"));
  const fresh = await upload(store);
  assert.deepEqual(await restarted.findNativeImageAttachment(url, sessionId), fresh.attachment);
});

test("lookup revalidates bytes and manifest UUID without reading other-session blobs", async (t) => {
  const { store } = await fixture(t);
  const { path } = await upload(store);
  await writeFile(path, Buffer.alloc(png.length));
  const other = await store.findNativeImageAttachment(url, "other-thread");
  assert.ok(other);
  assert.deepEqual(await readFile((await store.resolve(other.ref, "other-thread")).path), png);
  await assert.rejects(store.findNativeImageAttachment(url, sessionId), /checksumMismatch/);
  await writeFile(path, "short");
  await assert.rejects(store.findNativeImageAttachment(url, sessionId), /lengthMismatch/);
  const manifest = path.replace(/\.data$/, ".json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...metadata, id: randomUUID() }));
  const recovered = await store.findNativeImageAttachment(url, sessionId);
  assert.ok(recovered);
  assert.notEqual((await store.resolve(recovered.ref, sessionId)).path, path);
});

test("unmatched native history persists derived previews with stable refs after restart", async (t) => {
  const { store, create, root } = await fixture(t);
  const refs = await Promise.all(
    Array.from({ length: 4 }, () => store.findNativeImageAttachment(url, sessionId)),
  );
  const first = refs[0];
  assert.ok(first);
  for (const ref of refs) assert.deepEqual(ref, first);
  assert.equal(first.fileName, "native-image.png");
  const resolved = await store.resolve(first.ref, sessionId);
  const metadata = JSON.parse(await readFile(resolved.path.replace(/\.data$/, ".json"), "utf8"));
  assert.equal(metadata.derived, true);
  assert.deepEqual(await readFile(resolved.path), png);
  assert.deepEqual(await readdir(join(root, "staging")), []);
  assert.equal((await readdir(join(root, "objects"))).length, 2);
  await assert.rejects(
    store.handle(V4_METHODS.attachmentRead, {
      sessionId,
      ref: first.ref,
      offset: 0,
      limit: png.length,
    }),
    /previewRefNotAuthorized/,
  );
  await store.close();
  assert.deepEqual(await create().findNativeImageAttachment(url, sessionId), first);
});

test("derived images stream multiple chunks and use normal row-gated preview reads", async (t) => {
  const { store, root, cwd } = await fixture(t);
  const bytes = Buffer.alloc(LIMITS.attachmentChunkMaxBytes + 23, 137);
  const image = await store.findNativeImageAttachment(
    `data:image/png;base64,${bytes.toString("base64")}`,
    sessionId,
  );
  assert.ok(image);
  const resolved = await store.resolve(image.ref, sessionId);
  assert.deepEqual(await readFile(resolved.path), bytes);
  let allowed = true;
  const reader = new AttachmentStore({ cwd, root, authorizeRead: () => allowed });
  t.after(() => reader.close());
  const params = { sessionId, ref: image.ref, offset: LIMITS.attachmentChunkMaxBytes, limit: 23 };
  assert.deepEqual(await reader.handle(V4_METHODS.attachmentRead, params), {
    dataBase64: bytes.subarray(LIMITS.attachmentChunkMaxBytes).toString("base64"),
    mediaType: "image/png",
    totalBytes: bytes.length,
    nextOffset: null,
  });
  allowed = false;
  await assert.rejects(reader.handle(V4_METHODS.attachmentRead, params), /previewRefNotAuthorized/);
});

for (const [mime, extension] of [
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]) {
  test(`derived filename comes only from whitelisted ${mime}`, async (t) => {
    const { store } = await fixture(t);
    const ref = await store.findNativeImageAttachment(url.replace("image/png", mime!), sessionId);
    assert.equal(ref?.fileName, `native-image.${extension}`);
    assert.equal(ref?.mime, mime);
  });
}

for (const target of ["blob", "manifest"] as const) {
  for (const kind of ["symlink", "hardlink"] as const) {
    test(
      `image lookup rejects ${kind} ${target}`,
      { skip: process.platform === "win32" },
      async (t) => {
        const { store, cwd } = await fixture(t);
        const { path } = await upload(store);
        const selected = target === "blob" ? path : path.replace(/\.data$/, ".json");
        const outside = join(cwd, "outside");
        await writeFile(outside, await readFile(selected));
        await unlink(selected);
        if (kind === "symlink") await symlink(outside, selected);
        else await link(outside, selected);
        await assert.rejects(store.findNativeImageAttachment(url, sessionId), /unsafeStoragePath/);
      },
    );
  }
}

test("image lookup obeys store close", async (t) => {
  const { store } = await fixture(t);
  await store.close();
  await assert.rejects(store.findNativeImageAttachment(url, sessionId), /closed/);
});

test("directory scanning has a hard entry budget and fails explicitly", async (t) => {
  const { store, root } = await fixture(t);
  await upload(store);
  for (let offset = 0; offset < 4096; offset += 64) {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        writeFile(join(root, "objects", `ignored-${offset + index}`), ""),
      ),
    );
  }
  await assert.rejects(store.findNativeImageAttachment(url, sessionId), /lookupLimit/);
});

test("decoded size is checked even when encoded length fits the base64 ceiling", async (t) => {
  const { store, root } = await fixture(t);
  const oversized = Buffer.alloc(LIMITS.attachmentMaxBytes + 1).toString("base64");
  assert.equal(
    await store.findNativeImageAttachment(`data:image/png;base64,${oversized}`, sessionId),
    undefined,
  );
  await assert.rejects(lstat(root), { code: "ENOENT" });
});
