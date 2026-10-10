import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeToolArtifactStore } from "../src/storage/index.js";
import type { SessionId } from "@codez/contracts";

test("CLI materializes the original bytes, not the stored data URL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-prompt-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new NodeToolArtifactStore({
    rootDir: join(root, "artifacts"),
    imageCacheRootDir: join(root, "images"),
    videoCacheRootDir: join(root, "videos"),
  });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const sessionId = "session-1" as SessionId;
  const artifact = await store.writeToolResultArtifact({
    sessionId,
    toolCallId: "upload",
    toolName: "prompt-attachment:upload",
    contentType: "text/plain",
    content: `data:application/zip;base64,${bytes.toString("base64")}`,
  });
  const path = await store.ensurePromptAttachmentPath({
    uri: artifact.uri,
    sessionId,
    maxBytes: 20 * 1024 * 1024,
  });
  assert.deepEqual(await readFile(path), bytes);
  assert.notEqual(path, artifact.path);
  assert.equal(
    await store.ensurePromptAttachmentPath({
      uri: artifact.uri,
      sessionId,
      maxBytes: 20 * 1024 * 1024,
    }),
    path,
  );
  await assert.rejects(
    store.ensurePromptAttachmentPath({
      uri: artifact.uri,
      sessionId: "other" as SessionId,
      maxBytes: 20 * 1024 * 1024,
    }),
    /another session/,
  );
  await writeFile(path, "corrupt");
  await assert.rejects(
    store.ensurePromptAttachmentPath({
      uri: artifact.uri,
      sessionId,
      maxBytes: 20 * 1024 * 1024,
    }),
    /differs/,
  );
});
