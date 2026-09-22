import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { test, type TestContext } from "node:test";
import {
  V4_METHODS,
  attachmentRefSchema,
  v4AttachmentCommitResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentStore } from "../src/attachments.js";

const sessionId = "native-thread";
const scope = { sessionId, connectionId: "connection", uploadId: "image-upload" };
const fakeId = "00000000-0000-4000-8000-000000000000";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "zcode native lookup 中文 "));
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
  return { cwd, root, store, create };
}

async function upload(store: AttachmentStore) {
  const bytes = Buffer.from([137, 80, 78, 71]);
  await store.handle(V4_METHODS.attachmentBegin, {
    ...scope,
    fileName: "照片.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: 1,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  await store.handle(V4_METHODS.attachmentChunk, {
    ...scope,
    chunkIndex: 0,
    dataBase64: bytes.toString("base64"),
  });
  const { ref } = v4AttachmentCommitResultSchema.parse(
    await store.handle(V4_METHODS.attachmentCommit, scope),
  );
  const attachment = { ref, fileName: "照片.png", mime: "image/png", bytes: bytes.length };
  const [input] = await store.toNativeInput([attachment], sessionId);
  assert.equal(input?.type, "localImage");
  if (input?.type !== "localImage") throw new Error("Expected native local image");
  return { attachment, path: input.path };
}

test("native image path restores the persisted AttachmentRef before and after restart", async (t) => {
  const { store, create } = await fixture(t);
  const { attachment, path } = await upload(store);
  assert.deepEqual(
    attachmentRefSchema.parse(await store.findNativeAttachment(path, sessionId)),
    attachment,
  );
  await store.close();
  const restarted = create();
  assert.deepEqual(await restarted.findNativeAttachment(path, sessionId), attachment);
  // 反查仅补全投影元信息，不能绕过 main 对权威 user row 的预览授权。
  await assert.rejects(
    restarted.handle(V4_METHODS.attachmentRead, {
      sessionId,
      ref: attachment.ref,
      offset: 0,
      limit: 4,
    }),
    /previewRefNotAuthorized/,
  );
});

test("reverse lookup enforces session, workspace and root ownership", async (t) => {
  const { store, cwd, root, create } = await fixture(t);
  const { path } = await upload(store);
  assert.equal(await store.findNativeAttachment(path, "other-thread"), undefined);
  assert.equal(await store.findNativeAttachment(path, ""), undefined);
  const otherWorkspace = create({ cwd: join(cwd, "other-workspace"), root });
  assert.equal(await otherWorkspace.findNativeAttachment(path, sessionId), undefined);
  const otherRoot = create({ cwd, root: join(cwd, "other-store") });
  assert.equal(await otherRoot.findNativeAttachment(path, sessionId), undefined);
  await assert.rejects(lstat(join(cwd, "other-store")), { code: "ENOENT" });
  await writeFile(path, "corrupt");
  assert.equal(await store.findNativeAttachment(path, "other-thread"), undefined);
});

test("unrelated and noncanonical paths are rejected before any storage I/O", async (t) => {
  const { store, cwd, root } = await fixture(t);
  const expected = join(root, "objects", `${fakeId}.data`);
  const paths = [
    "",
    join(cwd, `${fakeId}.data`),
    join(`${root}-sibling`, "objects", `${fakeId}.data`),
    relative(cwd, expected),
    basename(expected),
    `file://${expected}`,
    `zcode-attachment://${fakeId}`,
    `${dirname(expected)}${sep}..${sep}objects${sep}${basename(expected)}`,
    `${dirname(expected)}${sep}.${sep}${basename(expected)}`,
    `${dirname(expected)}${sep}${sep}${basename(expected)}`,
    `${expected}${sep}`,
    `${expected}\0`,
    `${expected}:stream`,
    `${expected}.json`,
    join(root, "objects", "not-a-uuid.data"),
    join(root, "objects", `${fakeId}\n.data`),
    join(root, "staging", `${fakeId}.data`),
    join(root, "objects", `%2e%2e%2f${fakeId}.data`),
  ];
  for (const path of paths)
    assert.equal(await store.findNativeAttachment(path, sessionId), undefined, path);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("canonical-looking paths without a committed manifest return no match", async (t) => {
  const { store, root } = await fixture(t);
  assert.equal(
    await store.findNativeAttachment(join(root, "objects", `${fakeId}.data`), sessionId),
    undefined,
  );
  const { path } = await upload(store);
  const manifest = path.replace(/\.data$/, ".json");
  await unlink(manifest);
  assert.equal(await store.findNativeAttachment(path, sessionId), undefined);
});

test("missing blobs return no match and integrity errors are not hidden", async (t) => {
  const { store } = await fixture(t);
  const { path } = await upload(store);
  const original = await readFile(path);
  await writeFile(path, Buffer.alloc(original.length, 0));
  await assert.rejects(store.findNativeAttachment(path, sessionId), /checksumMismatch/);
  await writeFile(path, "longer");
  await assert.rejects(store.findNativeAttachment(path, sessionId), /lengthMismatch/);
  await unlink(path);
  assert.equal(await store.findNativeAttachment(path, sessionId), undefined);
});

test("manifest identity must match the path-derived UUID", async (t) => {
  const { store } = await fixture(t);
  const { path } = await upload(store);
  const manifest = path.replace(/\.data$/, ".json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...metadata, id: fakeId }));
  assert.equal(await store.findNativeAttachment(path, sessionId), undefined);
  await writeFile(manifest, "invalid json");
  await assert.rejects(store.findNativeAttachment(path, sessionId));
});

test(
  "path aliases and symlinked content never grant a reverse lookup",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, cwd } = await fixture(t);
    const { path } = await upload(store);
    const alias = join(cwd, "alias.data");
    await symlink(path, alias);
    assert.equal(await store.findNativeAttachment(alias, sessionId), undefined);
    const outside = join(cwd, "outside");
    await writeFile(outside, "secret");
    await unlink(path);
    await symlink(outside, path);
    await assert.rejects(store.findNativeAttachment(path, sessionId), /unsafeStoragePath/);
    assert.equal(await readFile(outside, "utf8"), "secret");
  },
);

test(
  "lookup cannot follow a symlinked manifest",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, cwd } = await fixture(t);
    const { path } = await upload(store);
    const manifest = path.replace(/\.data$/, ".json");
    const outside = join(cwd, "outside.json");
    await writeFile(outside, await readFile(manifest));
    await unlink(manifest);
    await symlink(outside, manifest);
    await assert.rejects(store.findNativeAttachment(path, sessionId), /unsafeStoragePath/);
  },
);

test("reverse lookup respects store close", async (t) => {
  const { store } = await fixture(t);
  const { path } = await upload(store);
  await store.close();
  await assert.rejects(store.findNativeAttachment(path, sessionId), /closed/);
});
