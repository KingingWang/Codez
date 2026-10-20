import { createServiceDescriptor } from "./descriptors.js";
import { ServiceChannels } from "@codez/shared";
import type { ConversationRowTarget } from "@codez/shared/codez-protocol-v4";

export type CodexDesktopFileRewindFailureReason =
  | "capability_missing"
  | "conversation_changed"
  | "target_missing"
  | "unsafe_projection"
  | "identity_mismatch"
  | "baseline_mismatch"
  | "backup_verification_failed"
  | "restore_verification_failed"
  | "needs_manual_recovery"
  | "unknown";

export interface CodexDesktopFileRewindTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface CodexDesktopFileRewindPreviewResult {
  canApply: boolean;
  safeFiles: Array<{
    action: "restore" | "delete";
    operationCount: number;
    path: string;
    toolNames: string[];
  }>;
  unsafeFiles: Array<{
    message?: string;
    operationCount: number;
    path: string;
    reason:
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "external_modified"
      | "file_read_failed"
      | "unsupported_checkpoint";
    toolNames: string[];
  }>;
  ignoredFiles: Array<{
    operationCount: number;
    path: string;
    reason: "bash_ignored";
    toolNames: string[];
  }>;
}

export interface CodexDesktopFileRewindApplyParams extends CodexDesktopFileRewindTarget {
  confirmationId: string;
}

export interface CodexDesktopFileRewindStatus {
  backupDir?: string;
  confirmationId: string;
  ledgerFile?: string;
  message?: string;
  reason?: CodexDesktopFileRewindFailureReason;
  state:
    | "idle"
    | "confirmed"
    | "backing-up"
    | "backup-complete"
    | "restoring"
    | "restored"
    | "success"
    | "failed"
    | "needs-manual-recovery"
    | "unknown";
}

export interface CodexDesktopFileRewindProjectionOverlayParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  target: ConversationRowTarget;
  turnId: string;
}

export interface ICodexDesktopFileRewindService {
  preview(params: CodexDesktopFileRewindTarget): Promise<CodexDesktopFileRewindPreviewResult>;
  apply(params: CodexDesktopFileRewindApplyParams): Promise<CodexDesktopFileRewindStatus>;
  status(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<CodexDesktopFileRewindStatus>;
}

export const ICodexDesktopFileRewindService =
  createServiceDescriptor<ICodexDesktopFileRewindService>(ServiceChannels.CodexDesktopFileRewind);
