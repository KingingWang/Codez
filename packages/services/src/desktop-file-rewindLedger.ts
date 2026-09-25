import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const codexFileRewindStates = [
  "confirmed",
  "backing-up",
  "backup-complete",
  "restoring",
  "restored",
  "success",
  "failed",
  "needs-manual-recovery",
] as const;
export type CodexFileRewindState = (typeof codexFileRewindStates)[number];

export interface CodexFileRewindPathPlan {
  readonly absolutePath: string;
  readonly baselineHash: string;
  readonly preimage: string;
  readonly preimageHash: string;
}

export interface CodexFileRewindLedger {
  readonly schemaVersion: 1;
  readonly createdAt: number;
  readonly workspaceKey: string;
  readonly workspaceIdentity: string | null;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly target: { readonly rowId: number; readonly entityId: string };
  readonly turnId?: string;
  readonly baseRevision: number;
  readonly baseLogEpoch: string;
  readonly previewDigest: string;
  readonly backupId: string;
  readonly paths: readonly CodexFileRewindPathPlan[];
  readonly confirmationId: string;
  readonly state: CodexFileRewindState;
  readonly transitionCount?: number;
  readonly failureReason?: string;
  readonly message?: string;
}

export function resolveCodexFileRewindWorkspaceKey(target: {
  workspaceIdentity?: string;
  workspacePath: string;
}): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function canonicalCodexFileRewindProjection(value: {
  baseLogEpoch: string;
  baseRevision: number;
  entityId: string;
  rowId: number;
  files: ReadonlyArray<{
    operationCount: number;
    path: string;
    toolNames: readonly string[];
  }>;
}): string {
  return JSON.stringify({
    baseLogEpoch: value.baseLogEpoch,
    baseRevision: value.baseRevision,
    entityId: value.entityId,
    files: [...value.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        operationCount: file.operationCount,
        path: file.path,
        toolNames: [...file.toolNames].sort(),
      })),
    rowId: value.rowId,
  });
}

export function codexFileRewindPreviewDigest(value: {
  baseLogEpoch: string;
  baseRevision: number;
  entityId: string;
  files: ReadonlyArray<{ operationCount: number; path: string; toolNames: readonly string[] }>;
  rowId: number;
}): string {
  return createHash("sha256")
    .update(canonicalCodexFileRewindProjection(value), "utf8")
    .digest("hex");
}

function isLedger(value: unknown): value is CodexFileRewindLedger {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CodexFileRewindLedger>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.workspaceKey === "string" &&
    typeof candidate.workspacePath === "string" &&
    typeof candidate.confirmationId === "string" &&
    typeof candidate.createdAt === "number" &&
    (codexFileRewindStates as readonly string[]).includes(String(candidate.state)) &&
    Array.isArray(candidate.paths)
  );
}

export class CodexFileRewindLedgerStore {
  constructor(private readonly rootDir: string) {}

  ledgerFile(workspaceKey: string): string {
    return join(
      this.rootDir,
      createHash("sha256").update(workspaceKey, "utf8").digest("hex").slice(0, 12),
      "transaction.json",
    );
  }

  backupDir(workspaceKey: string, backupId: string): string {
    return join(
      this.rootDir,
      createHash("sha256").update(workspaceKey, "utf8").digest("hex").slice(0, 12),
      "backups",
      backupId,
    );
  }

  async load(workspaceKey: string): Promise<CodexFileRewindLedger | null> {
    try {
      const parsed = JSON.parse(await readFile(this.ledgerFile(workspaceKey), "utf8")) as unknown;
      if (!isLedger(parsed) || parsed.workspaceKey !== workspaceKey) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async loadResult(workspaceKey: string): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "invalid" }
    | {
        readonly kind: "loaded";
        readonly ledger: CodexFileRewindLedger;
      }
  > {
    const ledger = await this.load(workspaceKey);
    if (!ledger) {
      try {
        await readFile(this.ledgerFile(workspaceKey), "utf8");
        return { kind: "invalid" };
      } catch {
        return { kind: "absent" };
      }
    }
    return { kind: "loaded", ledger };
  }

  async save(ledger: CodexFileRewindLedger): Promise<void> {
    const file = this.ledgerFile(ledger.workspaceKey);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(temp, file);
  }

  async removeWorkspace(workspaceKey: string): Promise<void> {
    await rm(
      join(
        this.rootDir,
        createHash("sha256").update(workspaceKey, "utf8").digest("hex").slice(0, 12),
      ),
      {
        force: true,
        recursive: true,
      },
    );
  }
}

export function newCodexFileRewindBackupId(): string {
  return randomUUID();
}
