import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  hashCodexFileRewindContent as hashContent,
  readCodexFileRewindRegularTextFile as readRegularTextFile,
} from "./desktop-file-rewindFiles.js";
import {
  createCodexDesktopFileRewindPlans,
  type CodexDesktopFileRewindAgentService,
} from "./desktop-file-rewindPlans.js";
import {
  codexFileRewindStates,
  CodexFileRewindLedgerStore,
  codexFileRewindPreviewDigest,
  newCodexFileRewindBackupId,
  resolveCodexFileRewindWorkspaceKey,
  type CodexFileRewindLedger,
  type CodexFileRewindPathPlan,
} from "./desktop-file-rewindLedger.js";
import { applyRewindPatches, type RewindPreview } from "./desktop-file-rewindPatch.js";
import type {
  CodexDesktopFileRewindPreviewResult,
  CodexDesktopFileRewindStatus,
  CodexDesktopFileRewindProjectionOverlayParams,
  ICodexDesktopFileRewindService,
} from "./desktop-file-rewind.js";

function toStatus(
  ledger: CodexFileRewindLedger | null,
  workspaceKey: string,
  store: CodexFileRewindLedgerStore,
): CodexDesktopFileRewindStatus {
  if (!ledger) return { confirmationId: "", state: "idle" };
  return {
    backupDir: store.backupDir(ledger.workspaceKey, ledger.backupId),
    confirmationId: ledger.confirmationId,
    ledgerFile: store.ledgerFile(workspaceKey),
    message: ledger.message,
    state: ledger.state,
  };
}

function failure(reason: CodexDesktopFileRewindStatus["reason"], message: string): never {
  throw Object.assign(new Error(message), { reason });
}

export function createCodexDesktopFileRewindService(options: {
  agentService: CodexDesktopFileRewindAgentService;
  isRegisteredOwner?: () => boolean;
  rootDir: string;
}): ICodexDesktopFileRewindService {
  const agentService = options.agentService;
  const store = new CodexFileRewindLedgerStore(options.rootDir);
  // The registered owner is the second half of the capability conjunction. Old hosts may
  // copy a supported bridge matrix without exposing this Desktop-local service descriptor.
  const isRegisteredOwner = options.isRegisteredOwner ?? (() => true);
  const workspaceKey = (target: { workspaceIdentity?: string; workspacePath: string }) =>
    resolveCodexFileRewindWorkspaceKey(target);
  const overlayProjection = async (target: CodexDesktopFileRewindProjectionOverlayParams) =>
    agentService.conversationFileRewindProjectionOverlayV4(target);
  const ensureProjectionOverlay = async (
    ledger: CodexFileRewindLedger,
    fallbackTurnId?: string,
  ) => {
    const turnId = ledger.turnId ?? fallbackTurnId;
    if (!turnId) return;
    await overlayProjection({
      workspacePath: ledger.workspacePath,
      ...(ledger.workspaceIdentity ? { workspaceIdentity: ledger.workspaceIdentity } : {}),
      sessionId: ledger.sessionId,
      target: ledger.target,
      turnId,
    });
  };

  async function ensureCapability(): Promise<void> {
    const hello = await agentService.helloConversationV4();
    if (!isRegisteredOwner() || hello.capabilities.codex?.safeDesktopFileRewind !== "supported")
      failure("capability_missing", "Safe Codex desktop file rewind is unavailable");
  }

  const buildPlans = createCodexDesktopFileRewindPlans({
    agentService,
    failure,
  });

  async function transition(
    ledger: CodexFileRewindLedger,
    state: CodexFileRewindLedger["state"],
    extra?: Partial<CodexFileRewindLedger>,
  ) {
    const next = { ...ledger, ...extra, state, transitionCount: (ledger.transitionCount ?? 0) + 1 };
    await store.save(next);
    return next;
  }

  async function validateRecoveredPlans(
    ledger: CodexFileRewindLedger,
    preview: RewindPreview,
  ): Promise<readonly CodexFileRewindPathPlan[]> {
    return Promise.all(
      preview.plans.map(async (plan) => {
        const current = await readRegularTextFile(plan.absolutePath);
        if (current === null) failure("baseline_mismatch", "Affected file is missing");
        const committedPath = ledger.paths.find((item) => item.absolutePath === plan.absolutePath);
        if (committedPath && hashContent(current) !== committedPath.baselineHash)
          failure("baseline_mismatch", "Affected file changed before rewind recovery");
        // The projected patch must still apply to the current baseline. This is
        // especially important when recovering a `backing-up` ledger before its path
        // hashes were committed.
        if (applyRewindPatches(current, plan.patches) !== plan.preimage)
          failure("unsafe_projection", "Recovered rewind plan no longer matches the ledger");
        // A `backing-up` crash can predate the ledger path write; for committed ledger
        // paths, both immutable hashes must still match the revalidated projection.
        if (
          committedPath &&
          (hashContent(plan.preimage) !== committedPath.preimageHash ||
            hashContent(current) !== committedPath.baselineHash)
        )
          failure("unsafe_projection", "Recovered rewind plan no longer matches the ledger");
        return {
          absolutePath: plan.absolutePath,
          baselineHash: hashContent(current),
          preimage: plan.preimage,
          preimageHash: hashContent(plan.preimage),
        };
      }),
    );
  }

  async function createBackup(
    ledger: CodexFileRewindLedger,
    preview: RewindPreview,
    key: string,
  ): Promise<{ ledger: CodexFileRewindLedger; pathPlans: readonly CodexFileRewindPathPlan[] }> {
    let currentLedger = ledger;
    currentLedger = await transition(currentLedger, "backing-up");
    const backupDir = store.backupDir(key, currentLedger.backupId);
    const staging = `${backupDir}.staging-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const pathPlans: CodexFileRewindPathPlan[] = [];
    try {
      for (const plan of preview.plans) {
        const current = await readRegularTextFile(plan.absolutePath);
        if (current === null) failure("baseline_mismatch", "Affected file changed before backup");
        const backupPath = join(staging, Buffer.from(plan.absolutePath).toString("base64url"));
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, current, "utf8");
        const verified = await readFile(backupPath, "utf8");
        const baselineHash = hashContent(current);
        if (verified !== current || hashContent(verified) !== baselineHash)
          failure("backup_verification_failed", "Backup verification failed");
        pathPlans.push({
          absolutePath: plan.absolutePath,
          baselineHash,
          preimage: plan.preimage,
          preimageHash: hashContent(plan.preimage),
        });
      }
      await rename(staging, backupDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      const failed = await transition(currentLedger, "failed", {
        message: error instanceof Error ? error.message : String(error),
        failureReason:
          error instanceof Error && "reason" in error && error.reason === "baseline_mismatch"
            ? "baseline_mismatch"
            : "backup_verification_failed",
      });
      void failed;
      throw error;
    }
    currentLedger = await transition({ ...currentLedger, paths: pathPlans }, "backup-complete");
    return { ledger: currentLedger, pathPlans };
  }

  async function verifyBackup(
    ledger: CodexFileRewindLedger,
  ): Promise<readonly CodexFileRewindPathPlan[]> {
    const backupDir = store.backupDir(ledger.workspaceKey, ledger.backupId);
    const names = await readdir(backupDir).catch(() => null);
    if (!names) failure("backup_verification_failed", "Rewind backup is missing");
    const expectedNames = new Set(
      ledger.paths.map((path) => Buffer.from(path.absolutePath).toString("base64url")),
    );
    if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name)))
      failure("backup_verification_failed", "Rewind backup is incomplete");
    await Promise.all(
      ledger.paths.map(async (path) => {
        const content = await readFile(
          join(backupDir, Buffer.from(path.absolutePath).toString("base64url")),
          "utf8",
        ).catch(() => null);
        if (content === null || hashContent(content) !== path.baselineHash)
          failure("backup_verification_failed", "Rewind backup is corrupt");
      }),
    );
    return ledger.paths.map((path) => ({ ...path }));
  }

  async function verifyBaselineAndRestore(
    initialLedger: CodexFileRewindLedger,
    pathPlans: readonly CodexFileRewindPathPlan[],
    key: string,
    turnId: string,
  ): Promise<CodexDesktopFileRewindStatus> {
    let ledger = initialLedger;
    for (const plan of pathPlans) {
      const current = await readRegularTextFile(plan.absolutePath);
      if (current === null || hashContent(current) !== plan.baselineHash)
        failure("baseline_mismatch", "Affected file changed after backup");
    }

    ledger = await transition(ledger, "restoring");
    try {
      for (const plan of pathPlans) {
        if (plan.preimage === "") await rm(plan.absolutePath, { force: true });
        else await writeFile(plan.absolutePath, plan.preimage, "utf8");
      }
    } catch (error) {
      const failed = await transition(ledger, "needs-manual-recovery", {
        message: error instanceof Error ? error.message : String(error),
        failureReason: "needs_manual_recovery",
      });
      return toStatus(failed, key, store);
    }

    ledger = await transition(ledger, "restored");
    for (const plan of pathPlans) {
      const current = await readRegularTextFile(plan.absolutePath);
      const actual = current === null ? null : hashContent(current);
      // 新增文件撤销的目标是「文件不存在」，不能拿 null 与空字符串的哈希比较；
      // 否则删除成功却会误记为需人工恢复。其余恢复仍按字节哈希严格校验。
      const verified = plan.preimage === "" ? current === null : actual === plan.preimageHash;
      if (!verified) {
        const failed = await transition(ledger, "needs-manual-recovery", {
          message: "Restore verification failed",
          failureReason: "restore_verification_failed",
        });
        return toStatus(failed, key, store);
      }
    }
    ledger = await transition({ ...ledger, turnId }, "success");
    await ensureProjectionOverlay(ledger, turnId);
    return toStatus(ledger, key, store);
  }

  return {
    async preview(target): Promise<CodexDesktopFileRewindPreviewResult> {
      await ensureCapability();
      const { preview } = await buildPlans(target);
      return {
        canApply: preview.canApply,
        ignoredFiles: preview.ignoredFiles,
        safeFiles: preview.safeFiles,
        unsafeFiles: preview.unsafeFiles,
      };
    },

    async apply(target): Promise<CodexDesktopFileRewindStatus> {
      await ensureCapability();
      const key = workspaceKey(target);
      const loaded = await store.loadResult(key);
      if (loaded.kind === "invalid") {
        failure("unknown", "Safe file rewind ledger is invalid; manual recovery is required");
      }
      const existing = loaded.kind === "loaded" ? loaded.ledger : undefined;
      if (existing) {
        if (existing.confirmationId !== target.confirmationId) {
          failure(
            "needs_manual_recovery",
            "A rewind transaction already exists for this workspace",
          );
        }
        if (existing.state === "success") {
          // Bridge/Host restart may lose its in-memory derived overlay. A successful
          // transaction is immutable, but retrying the same confirmation can safely
          // replay the overlay using the durable guarded turn id.
          await ensureProjectionOverlay(existing);
          return toStatus(existing, key, store);
        }
        if (existing.state === "failed") return toStatus(existing, key, store);
        // These boundaries may already include workspace mutation. Projection is derived
        // from mutable current files, so retained ledger facts are the only safe source.
        if (
          existing.state === "restoring" ||
          existing.state === "restored" ||
          existing.state === "needs-manual-recovery"
        ) {
          if (existing.state === "restored") {
            for (const path of existing.paths) {
              const current = await readRegularTextFile(path.absolutePath);
              const actual = current === null ? null : hashContent(current);
              if (actual !== path.preimageHash)
                failure("restore_verification_failed", "Restore verification failed");
            }
            const completed = await transition(existing, "success");
            await ensureProjectionOverlay(completed);
            return toStatus(completed, key, store);
          }
          return toStatus(existing, key, store);
        }
      }

      const { preview, projection, turnId } = await buildPlans(target);
      if (!preview.canApply) failure("unsafe_projection", "File rewind projection is not safe");
      const identity = target.workspaceIdentity?.trim() || null;
      if (existing && existing.workspaceIdentity !== identity)
        failure("identity_mismatch", "Workspace identity changed before rewind");
      const previewDigest = codexFileRewindPreviewDigest({
        baseLogEpoch: target.baseLogEpoch,
        baseRevision: target.baseRevision,
        entityId: target.target.entityId,
        rowId: target.target.rowId,
        files: projection.items.map((item) => ({
          operationCount: item.writeCount,
          path: item.path,
          toolNames: item.toolNames,
        })),
      });
      if (existing && existing.previewDigest !== previewDigest) {
        failure("conversation_changed", "Confirmed rewind projection changed");
      }
      let ledger: CodexFileRewindLedger =
        existing ??
        ({
          schemaVersion: 1,
          createdAt: Date.now(),
          workspaceKey: key,
          workspaceIdentity: identity,
          workspacePath: target.workspacePath,
          sessionId: target.sessionId,
          target: target.target,
          baseRevision: target.baseRevision,
          baseLogEpoch: target.baseLogEpoch,
          previewDigest,
          backupId: newCodexFileRewindBackupId(),
          paths: [],
          confirmationId: target.confirmationId,
          turnId,
          state: "confirmed",
          transitionCount: 1,
        } satisfies CodexFileRewindLedger);

      if (!existing || existing.state === "confirmed") {
        const { ledger: backedUp, pathPlans } = await createBackup(ledger, preview, key);
        return await verifyBaselineAndRestore(backedUp, pathPlans, key, turnId);
      }
      if (existing.state === "backing-up") {
        // The atomic rename can commit before the ledger advances. Retain the backup only
        // when every expected byte matches the still-unmutated baseline; otherwise recreate.
        const backupDir = store.backupDir(key, existing.backupId);
        const expectedPlans = await validateRecoveredPlans(existing, preview);
        const expectedNames = new Set(
          expectedPlans.map((path) => Buffer.from(path.absolutePath).toString("base64url")),
        );
        const names = await readdir(backupDir).catch(() => []);
        const retained =
          names.length === expectedNames.size && names.every((name) => expectedNames.has(name));
        if (retained) {
          try {
            const recoveredPlans = await verifyBackup({ ...existing, paths: expectedPlans });
            const backedUp = await transition(
              { ...existing, paths: expectedPlans },
              "backup-complete",
            );
            return await verifyBaselineAndRestore(backedUp, recoveredPlans, key, turnId);
          } catch (error) {
            const reason = (error as { reason?: string }).reason;
            if (reason !== "backup_verification_failed") throw error;
            // A `backing-up` ledger never committed this directory; corrupt bytes mean the
            // atomic rename did not complete a valid backup and recreation remains safe.
            await rm(backupDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        const { ledger: backedUp, pathPlans } = await createBackup(existing, preview, key);
        return await verifyBaselineAndRestore(backedUp, pathPlans, key, turnId);
      }
      if (existing.state === "backup-complete") {
        const recoveredPlans = await validateRecoveredPlans(existing, preview);
        const pathPlans = await verifyBackup({ ...existing, paths: recoveredPlans });
        return await verifyBaselineAndRestore(existing, pathPlans, key, turnId);
      }
      return toStatus(existing, key, store);
    },

    async status(target): Promise<CodexDesktopFileRewindStatus> {
      const key = workspaceKey(target);
      const loaded = await store.loadResult(key);
      if (loaded.kind === "absent") return { confirmationId: "", state: "idle" };
      if (loaded.kind === "invalid")
        return { confirmationId: "", state: "unknown", ledgerFile: store.ledgerFile(key) };
      const ledger = loaded.ledger;
      if (!(codexFileRewindStates as readonly string[]).includes(ledger.state))
        return { confirmationId: ledger.confirmationId, state: "unknown" };
      return toStatus(ledger, key, store);
    },
  };
}
