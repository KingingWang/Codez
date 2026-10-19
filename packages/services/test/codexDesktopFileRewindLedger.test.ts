import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexFileRewindLedgerStore,
  codexFileRewindPreviewDigest,
  newCodexFileRewindBackupId,
  resolveCodexFileRewindWorkspaceKey,
} from "../src/desktop-file-rewindLedger.js";

test("workspace identity migration uses canonical key and preserves local path fallback", () => {
  assert.equal(
    resolveCodexFileRewindWorkspaceKey({ workspacePath: "/repo", workspaceIdentity: " identity " }),
    "identity",
  );
  assert.equal(resolveCodexFileRewindWorkspaceKey({ workspacePath: "/repo" }), "/repo");
  assert.equal(
    resolveCodexFileRewindWorkspaceKey({ workspacePath: "/repo", workspaceIdentity: " " }),
    "/repo",
  );
});

test("preview digest is canonical and unaffected by path/tool ordering", () => {
  const base = {
    baseLogEpoch: "epoch",
    baseRevision: 7,
    entityId: "entity",
    rowId: 3,
    files: [
      { operationCount: 2, path: "b.txt", toolNames: ["ApplyPatch"] },
      { operationCount: 1, path: "a.txt", toolNames: ["ApplyPatch", "Edit"] },
    ],
  };
  const reordered = {
    ...base,
    files: [
      { operationCount: 1, path: "a.txt", toolNames: ["Edit", "ApplyPatch"] },
      { operationCount: 2, path: "b.txt", toolNames: ["ApplyPatch"] },
    ],
  };
  assert.equal(codexFileRewindPreviewDigest(base), codexFileRewindPreviewDigest(reordered));
  assert.match(codexFileRewindPreviewDigest(base), /^[a-f0-9]{64}$/);
});

test("ledger store keeps identity-keyed data and rejects invalid or foreign records", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-rewind-"));
  const store = new CodexFileRewindLedgerStore(root);
  const workspaceIdentity = "ssh://host/repo";
  const workspaceKey = resolveCodexFileRewindWorkspaceKey({
    workspacePath: "/remote/repo",
    workspaceIdentity,
  });
  const ledger = {
    schemaVersion: 1,
    createdAt: 1,
    workspaceKey,
    workspaceIdentity,
    workspacePath: "/remote/repo",
    sessionId: "session",
    target: { rowId: 3, entityId: "entity" },
    baseRevision: 7,
    baseLogEpoch: "epoch",
    previewDigest: "digest",
    backupId: newCodexFileRewindBackupId(),
    paths: [],
    confirmationId: "confirm",
    state: "confirmed",
  } as const;
  await store.save(ledger);
  const loaded = await store.load(workspaceKey);
  assert.equal(loaded?.workspaceIdentity, workspaceIdentity);
  assert.equal(loaded?.state, "confirmed");
  assert.equal(await store.load("foreign-key"), null);
  await writeFile(store.ledgerFile(workspaceKey), "{invalid", "utf8");
  assert.equal(await store.load(workspaceKey), null);
});
