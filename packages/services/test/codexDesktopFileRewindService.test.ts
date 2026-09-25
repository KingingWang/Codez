import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ICodexDesktopFileRewindService } from "../src/desktop-file-rewind.js";
import { createCodexDesktopFileRewindService } from "../src/desktop-file-rewindService.js";

type Projection = {
  files: number;
  additions: number;
  deletions: number;
  items: Array<{
    path: string;
    additions: number;
    deletions: number;
    writeCount: number;
    toolNames: string[];
    patches: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>;
  }>;
};

function projection(...items: Projection["items"]): Projection {
  return {
    files: items.length,
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
    items,
  };
}

function patch(): Projection["items"][number]["patches"][number] {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+context"] };
}

async function setup(options?: { capability?: "supported" | "unsupported" | undefined }) {
  const workspace = await mkdtemp(join(tmpdir(), "codez-rewind-work-"));
  const root = await mkdtemp(join(tmpdir(), "codez-rewind-state-"));
  await writeFile(join(workspace, "file.txt"), "context", "utf8");
  const calls: string[] = [];
  const overlays: Array<{ sessionId: string; turnId: string }> = [];
  const projected = projection({
    path: "file.txt",
    additions: 1,
    deletions: 0,
    writeCount: 1,
    toolNames: ["ApplyPatch"],
    patches: [patch()],
  });
  const capability = options?.capability ?? "supported";
  const agent = {
    helloConversationV4: async () => ({
      capabilities: {
        codex:
          capability === undefined
            ? undefined
            : {
                auxiliaryTextGeneration: "supported",
                observedSessionUsage: "supported",
                observedAppUsage: "supported",
                sharedContextContentCopy: "degraded",
                scheduledPromptAutomations: "supported",
                nativeBrowserCuaMcp: "unsupported",
                readOnlyWorkflowHistory: "unsupported",
                safeDesktopFileRewind: capability,
                legacyWorkflowRuns: "unsupported",
              },
      },
    }),
    conversationFileChangesV4: async () => {
      calls.push("projection");
      return projected;
    },
    conversationFileRewindProjectionOverlayV4: async (overlay: unknown) => {
      const value = overlay as { sessionId: string; turnId: string };
      overlays.push(value);
    },
    conversationRowsRangeV4: async (params: unknown) => {
      assert.equal((params as { beforeRowId?: number }).beforeRowId, 4);
      return {
        rows: [
          {
            rowId: 3,
            entityId: "entity",
            turnId: "turn-1",
            kind: "turnHeader",
            createdAt: 1,
            createdAtSeq: 0,
            origin: "userInput",
            executionKind: "agent",
            state: "completedSuccess",
            startedAt: 1,
          },
        ],
        atSeq: 1,
        atRevision: 7,
        atLogEpoch: "epoch",
        hasMore: false,
      };
    },
  };
  const service: ICodexDesktopFileRewindService = createCodexDesktopFileRewindService({
    agentService: agent,
    rootDir: root,
  });
  const target = {
    workspacePath: workspace,
    workspaceIdentity: "remote-identity",
    sessionId: "session",
    target: { rowId: 3, entityId: "entity" },
    baseRevision: 7,
    baseLogEpoch: "epoch",
  };
  return {
    agent,
    calls,
    overlays,
    projected,
    root,
    service,
    target,
    workspace,
    projectedConstant: projected,
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return String((error as { reason?: string }).reason ?? "");
  }
}

test("preview and successful apply follow fixed ledger order with backup retention", async () => {
  const h = await setup();
  const preview = await h.service.preview(h.target);
  assert.equal(preview.canApply, true);
  assert.deepEqual(preview.safeFiles, [
    { action: "restore", operationCount: 1, path: "file.txt", toolNames: ["ApplyPatch"] },
  ]);
  const status = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(status.state, "success");
  assert.equal(h.overlays.length, 1);
  assert.equal(h.overlays[0]?.sessionId, "session");
  assert.equal(h.overlays[0]?.turnId, "turn-1");
  // Bridge restart loses only the derived overlay; the retained success ledger can replay it.
  const retry = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(retry.state, "success");
  assert.equal(h.overlays.length, 2);
  assert.equal(h.overlays[1]?.sessionId, "session");
  assert.equal(h.overlays[1]?.turnId, "turn-1");
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");
  const after = await h.service.status(h.target);
  assert.equal(after.state, "success");
  const backupDir = after.backupDir!;
  assert.equal(
    await readFile(join(backupDir, await firstBackupName(backupDir)), "utf8"),
    "context",
  );
  assert.equal((await readFile(after.ledgerFile!, "utf8")).includes('"state": "success"'), true);
});

test("absolute native add within workspace can preview and delete its exact new file", async () => {
  const h = await setup();
  const file = join(h.workspace, "new.txt");
  await writeFile(file, "first\nsecond\n", "utf8");
  h.projected.items = [
    {
      path: file,
      additions: 2,
      deletions: 0,
      writeCount: 1,
      toolNames: ["ApplyPatch"],
      patches: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: ["+first", "+second"],
        },
      ],
    },
  ];
  h.projected.files = 1;
  const preview = await h.service.preview(h.target);
  assert.equal(preview.canApply, true);
  assert.equal(preview.safeFiles[0]?.action, "delete");
  const status = await h.service.apply({ ...h.target, confirmationId: "new-file" });
  assert.equal(status.state, "success");
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
});

test("native absolute sibling path is outside workspace and cannot be rewound", async () => {
  const h = await setup();
  h.projected.items[0]!.path = `${h.workspace}-sibling/file.txt`;
  const preview = await h.service.preview(h.target);
  assert.equal(preview.canApply, false);
  assert.equal(preview.unsafeFiles[0]?.reason, "unsupported_checkpoint");
});

async function firstBackupName(dir: string): Promise<string> {
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  return files[0]!;
}

test("registered owner is required even when the bridge projects support", async () => {
  const h = await setup();
  const unregistered: ICodexDesktopFileRewindService = createCodexDesktopFileRewindService({
    agentService: h.agent,
    isRegisteredOwner: () => false,
    rootDir: h.root,
  });
  assert.equal(await reason(unregistered.preview(h.target)), "capability_missing");
  assert.equal(
    await reason(unregistered.apply({ ...h.target, confirmationId: "confirm" })),
    "capability_missing",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");
});

test("capability missing fails closed without projection or workspace mutation", async () => {
  const h = await setup({ capability: "unsupported" });
  assert.equal(await reason(h.service.preview(h.target)), "capability_missing");
  assert.deepEqual(h.calls, []);
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");
});

test("external baseline mismatch is rejected before any mutation", async () => {
  const h = await setup();
  await writeFile(join(h.workspace, "file.txt"), "different\n", "utf8");
  const preview = await h.service.preview(h.target);
  assert.equal(preview.canApply, false);
  assert.equal(preview.unsafeFiles[0]?.reason, "external_modified");
  assert.equal(
    await reason(h.service.apply({ ...h.target, confirmationId: "confirm" })),
    "unsafe_projection",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "different\n");
});

test("restart restores confirmed, but never auto-continues a restoring ledger", async () => {
  const h = await setup();
  const success = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(success.state, "success");
  const status = await h.service.status(h.target);
  assert.equal(status.state, "success");
  // status intentionally exposes retained state without mutation; simulate restoring on disk.
  const raw = JSON.parse(await readFile(status.ledgerFile!, "utf8")) as { state: string };
  raw.state = "restoring";
  await writeFile(status.ledgerFile!, JSON.stringify(raw), "utf8");
  const restartedStatus = await h.service.status(h.target);
  assert.equal(restartedStatus.state, "restoring");
  h.agent.conversationFileChangesV4 = async () => {
    throw new Error("projection must not be consulted after possible mutation");
  };
  const retry = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(retry.state, "restoring");
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");
  assert.equal((await h.service.status(h.target)).state, "restoring");
});

test("a confirmed retry is bound to the confirmed projection digest", async () => {
  const h = await setup();
  const initial = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(initial.state, "success");
  const raw = JSON.parse(await readFile(initial.ledgerFile!, "utf8")) as { state: string };
  raw.state = "confirmed";
  await writeFile(initial.ledgerFile!, JSON.stringify(raw), "utf8");
  await writeFile(join(h.workspace, "file.txt"), "context", "utf8");
  const changed = { ...h.target, baseRevision: h.target.baseRevision + 1 };
  assert.equal(
    await reason(h.service.apply({ ...changed, confirmationId: "confirm" })),
    "conversation_changed",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");
});

test("crash boundaries retain verified backups and recover restored from ledger facts", async () => {
  const h = await setup();
  const initial = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(initial.state, "success");

  const resetConfirmed = async () => {
    const raw = JSON.parse(await readFile(initial.ledgerFile!, "utf8")) as { state: string };
    raw.state = "confirmed";
    await writeFile(initial.ledgerFile!, JSON.stringify(raw), "utf8");
    await writeFile(join(h.workspace, "file.txt"), "context", "utf8");
    await rm(initial.backupDir!, { recursive: true, force: true });
  };
  const setRawState = async (state: string) => {
    const raw = JSON.parse(await readFile(initial.ledgerFile!, "utf8")) as { state: string };
    raw.state = state;
    await writeFile(initial.ledgerFile!, JSON.stringify(raw), "utf8");
  };

  // The atomic backup rename can commit before the ledger reaches `backup-complete`.
  await resetConfirmed();
  await setRawState("backing-up");
  const backupName = Buffer.from(join(h.workspace, "file.txt")).toString("base64url");
  await mkdir(initial.backupDir!, { recursive: true });
  await writeFile(join(initial.backupDir!, backupName), "context", "utf8");
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "success",
  );
  assert.equal(await readFile(join(initial.backupDir!, backupName), "utf8"), "context");

  // An invalid committed backup is discarded and recreated before mutation.
  await resetConfirmed();
  await setRawState("backing-up");
  await mkdir(initial.backupDir!, { recursive: true });
  await writeFile(join(initial.backupDir!, backupName), "partial", "utf8");
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "success",
  );
  assert.equal(await readFile(join(initial.backupDir!, backupName), "utf8"), "context");
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");

  // `backup-complete` validates backup bytes, not only filenames.
  await resetConfirmed();
  await setRawState("backup-complete");
  await mkdir(initial.backupDir!, { recursive: true });
  await writeFile(join(initial.backupDir!, backupName), "corrupt", "utf8");
  assert.equal(
    await reason(h.service.apply({ ...h.target, confirmationId: "confirm" })),
    "backup_verification_failed",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");
  assert.equal((await h.service.status(h.target)).state, "backup-complete");
  await resetConfirmed();
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "success",
  );

  // A real restored crash leaves the preimage live; current projection may already be
  // unsafe and must not be consulted during read-only verification.
  await setRawState("restored");
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");
  h.agent.conversationFileChangesV4 = async () => {
    throw new Error("restored verification must use ledger hashes");
  };
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "success",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");

  await setRawState("restoring");
  await writeFile(join(h.workspace, "file.txt"), "context", "utf8");
  h.agent.conversationFileChangesV4 = async () => {
    throw new Error("restoring must remain manual without projection");
  };
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "restoring",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");

  const manual = JSON.parse(await readFile(initial.ledgerFile!, "utf8")) as { state: string };
  manual.state = "needs-manual-recovery";
  await writeFile(initial.ledgerFile!, JSON.stringify(manual), "utf8");
  assert.equal(
    (await h.service.apply({ ...h.target, confirmationId: "confirm" })).state,
    "needs-manual-recovery",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "context");
});

test("invalid retained ledger fails closed as unknown instead of idle", async () => {
  const h = await setup();
  const initial = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(initial.state, "success");
  await writeFile(initial.ledgerFile!, "{invalid", "utf8");
  assert.equal((await h.service.status(h.target)).state, "unknown");
  assert.equal(
    await reason(h.service.apply({ ...h.target, confirmationId: "confirm" })),
    "unknown",
  );
  assert.equal(await readFile(join(h.workspace, "file.txt"), "utf8"), "old");
});

test("identity mismatch cannot claim an identity-backed ledger", async () => {
  const h = await setup();
  const success = await h.service.apply({ ...h.target, confirmationId: "confirm" });
  assert.equal(success.state, "success");
  const foreign = { ...h.target, workspaceIdentity: "other" };
  assert.equal(
    await reason(h.service.apply({ ...foreign, confirmationId: "confirm" })),
    "unsafe_projection",
  );
  assert.equal((await h.service.status(foreign)).state, "idle");
});
