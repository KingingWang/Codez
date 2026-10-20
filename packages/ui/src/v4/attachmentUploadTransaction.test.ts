import assert from "node:assert/strict";
import test from "node:test";
import { uploadAttachmentTransaction } from "./attachmentUploadTransaction.js";

test("an empty file commits with zero chunks rather than disappearing", async () => {
  const calls: string[] = [];
  const result = await uploadAttachmentTransaction(
    {
      async attachmentBeginV4(params) {
        calls.push(`begin:${params.totalBytes}:${params.totalChunks}`);
        return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 };
      },
      async attachmentChunkV4() {
        throw new Error("empty upload must not create chunks");
      },
      async attachmentCommitV4() {
        calls.push("commit");
        return { ref: "codez-attachment://empty" };
      },
      async attachmentAbortV4() {
        throw new Error("empty upload must not abort");
      },
    },
    { workspacePath: "/workspace" },
    {
      sessionId: "session-1",
      fileName: "empty.bin",
      mime: "application/octet-stream",
      dataBase64: "",
    },
  );
  assert.equal(result.ref, "codez-attachment://empty");
  assert.deepEqual(calls, ["begin:0:0", "commit"]);
});
