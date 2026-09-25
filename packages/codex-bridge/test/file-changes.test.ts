import assert from "node:assert/strict";
import test from "node:test";
import { projectTurnFileChanges } from "../src/file-changes.js";

test("native unified patches render real file summaries without filesystem access", () => {
  const result = projectTurnFileChanges({
    items: [
      {
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "src/中文.ts",
            diff: "--- a/src/中文.ts\n+++ b/src/中文.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n",
          },
        ],
      },
    ],
  });
  assert.equal(result.files, 1);
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 1);
  assert.deepEqual(result.items[0]?.patches, [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" same", "-old", "+new"] },
  ]);
});
test("declined patches are not claimed as applied changes", () => {
  assert.equal(
    projectTurnFileChanges({
      items: [{ type: "fileChange", status: "declined", changes: [{ path: "x", diff: "+x" }] }],
    }).files,
    0,
  );
});
test("native full-content add/delete project real counts even when content resembles a hunk", () => {
  const result = projectTurnFileChanges({
    items: [
      {
        type: "fileChange",
        status: "completed",
        changes: [
          { kind: { type: "add" }, path: "/workspace/new.txt", diff: "first\n@@ -2,1 +2,1 @@\n" },
          { kind: { type: "delete" }, path: "/workspace/old.txt", diff: "old\n" },
        ],
      },
    ],
  });
  assert.equal(result.files, 2);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 1);
  assert.deepEqual(result.items[0]?.patches, [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ["+first", "+@@ -2,1 +2,1 @@"],
    },
  ]);
});
