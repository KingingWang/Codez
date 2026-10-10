import assert from "node:assert/strict";
import test from "node:test";
import { mapAttachmentRefsToTurnAttachments } from "../src/codez-protocol-v4/commands/attachment-refs.js";
import type { CodezApp } from "../src/app/types.js";

test("uploaded text and binary refs become complete Agent-readable paths", async () => {
  const calls: string[] = [];
  const app = {
    materializePromptAttachment: async (ref: string) => {
      calls.push(ref);
      return "/private/session/original-file";
    },
  } as unknown as CodezApp;
  const attachments = await mapAttachmentRefsToTurnAttachments(app, [
    {
      ref: "codez-artifact://session/long",
      fileName: "long.html",
      mime: "text/html",
      bytes: 64 * 1024 + 1,
    },
    {
      ref: "codez-artifact://session/zip",
      fileName: "archive.zip",
      mime: "application/zip",
      bytes: 4,
    },
  ]);
  assert.deepEqual(calls, ["codez-artifact://session/long", "codez-artifact://session/zip"]);
  assert.deepEqual(attachments, [
    {
      path: "/private/session/original-file",
      type: "file",
      filename: "long.html",
      mimeType: "text/html",
      sizeBytes: 64 * 1024 + 1,
    },
    {
      path: "/private/session/original-file",
      type: "file",
      filename: "archive.zip",
      mimeType: "application/zip",
      sizeBytes: 4,
    },
  ]);
});

test("clipboard text source kind survives V4 attachment mapping", async () => {
  const app = {} as CodezApp;
  assert.deepEqual(
    await mapAttachmentRefsToTurnAttachments(app, [
      {
        ref: "/private/pasted-text.txt",
        fileName: "pasted-text.txt",
        mime: "text/plain",
        bytes: 123,
        sourceKind: "clipboard-text",
      },
    ]),
    [
      {
        path: "/private/pasted-text.txt",
        type: "file",
        filename: "pasted-text.txt",
        mimeType: "text/plain",
        sizeBytes: 123,
        sourceKind: "clipboard-text",
      },
    ],
  );
});
