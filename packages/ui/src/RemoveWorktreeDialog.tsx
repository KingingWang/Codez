import { AlertTriangleIcon, LoaderIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  canConfirmWorktreeRemoval,
  resolveWorktreeRemovalBlock,
  resolveWorktreeRemovalRisk,
  type WorktreeRemovalState,
} from "./hooks/worktreeRemovalModel.js";

/**
 * 删除独立工作区确认弹层（specs/git-worktree-removal.md W2）。
 * 纯展示组件：全部判定走 worktreeRemovalModel 纯函数，入口行保持零状态。
 */

export interface RemoveWorktreeDialogProps {
  open: boolean;
  state: WorktreeRemovalState;
  onConfirmDiscardChanges: (checked: boolean) => void;
  onConfirmDiscardDetachedHead: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 预检/明确失败后的重试：重新预检。 */
  onRetry: () => void;
  /** 结果未知后的重试：按原 operationId 安全重放（W7）。 */
  onRetryUnknown: () => void;
  onJumpToWorkspace: (path: string) => void;
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-background/40 px-3 py-2">
      <span className="shrink-0 text-ui-sm text-foreground-subtle">{label}</span>
      <span className="min-w-0 flex-1 break-all text-right font-mono text-ui-sm text-foreground">
        {value}
      </span>
    </div>
  );
}

export function RemoveWorktreeDialogBody({
  state,
  onConfirmDiscardChanges,
  onConfirmDiscardDetachedHead,
  onConfirm,
  onCancel,
  onRetry,
  onRetryUnknown,
  onJumpToWorkspace,
}: Omit<RemoveWorktreeDialogProps, "open">) {
  const { intl } = useCodezIntl();
  const preview = state.preview;
  const block = preview ? resolveWorktreeRemovalBlock(preview, state.uiFacts) : null;
  const risk = preview ? resolveWorktreeRemovalRisk(preview) : null;
  const busy = state.phase === "removing";

  return (
    <>
      <DialogHeader className="gap-1 px-6 pt-6">
        <span className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "worktree.remove.title" })}
        </span>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.remove.description" })}
        </span>
      </DialogHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-6 py-4">
        {state.phase === "previewing" ? (
          <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "worktree.remove.previewPending" })}
          </div>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-2">
            <FactRow
              label={intl.formatMessage({ id: "worktree.remove.path" })}
              value={preview.targetPath}
            />
            <FactRow
              label={intl.formatMessage({ id: "worktree.remove.branch" })}
              value={
                preview.branchName ??
                intl.formatMessage(
                  { id: "worktree.remove.detachedHead" },
                  { hash: preview.headCommitHash?.slice(0, 7) ?? "?" },
                )
              }
            />
          </div>
        ) : null}

        {state.notice === "status-changed" ? (
          <p role="status" className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "worktree.remove.statusChanged" })}
          </p>
        ) : null}

        {block === "current" ? (
          <p role="alert" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "worktree.remove.blocked.current" })}
          </p>
        ) : null}
        {block === "running" ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "worktree.remove.blocked.running" })}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => preview && onJumpToWorkspace(preview.targetPath)}
              >
                {intl.formatMessage({ id: "worktree.remove.blocked.running.jump" })}
              </Button>
            </div>
          </div>
        ) : null}
        {block === "locked" ? (
          <p role="alert" className="flex items-start gap-1.5 text-ui-base text-foreground-subtle">
            <LockIcon className="mt-0.5 size-3.5 shrink-0" />
            {intl.formatMessage(
              { id: "worktree.remove.blocked.locked" },
              { reason: preview?.lockReason ?? "" },
            )}
          </p>
        ) : null}
        {block === "unreachable" ? (
          <p role="alert" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "worktree.remove.unreachable" })}
          </p>
        ) : null}
        {block === "risk-unknown" ? (
          <p role="alert" className="text-ui-base text-warning">
            {intl.formatMessage({ id: "worktree.remove.riskUnknown" })}
          </p>
        ) : null}

        {preview && !block && risk !== "clean" ? (
          <div className="flex flex-col gap-2">
            {preview.totalChangeCount > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-ui-sm font-medium text-foreground">
                  {intl.formatMessage(
                    { id: "worktree.remove.section.changes" },
                    { count: String(preview.totalChangeCount) },
                  )}
                </span>
                <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg bg-background/40 px-3 py-2">
                  {preview.changes.map((change) => (
                    <li
                      key={`${change.section}:${change.path}`}
                      className="truncate font-mono text-ui-sm text-foreground-subtle"
                      title={change.path}
                    >
                      {change.repoRelativePath}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.attentionTotalCount > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-ui-sm font-medium text-warning">
                  <AlertTriangleIcon className="size-3.5" />
                  {intl.formatMessage(
                    { id: "worktree.remove.section.attention" },
                    { count: String(preview.attentionTotalCount) },
                  )}
                </span>
                <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto rounded-lg bg-background/40 px-3 py-2">
                  {preview.attentionPaths.map((path) => (
                    <li
                      key={path}
                      className="truncate font-mono text-ui-sm text-foreground-subtle"
                      title={path}
                    >
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {preview && !block && (risk === "dirty" || risk === "dirty+detached") ? (
          <label className="flex cursor-pointer items-start gap-2 text-ui-base text-foreground">
            <Checkbox
              checked={state.confirmDiscardChanges}
              onCheckedChange={(checked) => onConfirmDiscardChanges(checked === true)}
              aria-label={intl.formatMessage(
                { id: "worktree.remove.confirmDiscardChanges" },
                {
                  count: String(preview.totalChangeCount + preview.attentionTotalCount),
                },
              )}
            />
            <span>
              {intl.formatMessage(
                { id: "worktree.remove.confirmDiscardChanges" },
                { count: String(preview.totalChangeCount + preview.attentionTotalCount) },
              )}
            </span>
          </label>
        ) : null}
        {preview && !block && (risk === "detached" || risk === "dirty+detached") ? (
          <label className="flex cursor-pointer items-start gap-2 text-ui-base text-foreground">
            <Checkbox
              checked={state.confirmDiscardDetachedHead}
              onCheckedChange={(checked) => onConfirmDiscardDetachedHead(checked === true)}
              aria-label={intl.formatMessage({ id: "worktree.remove.confirmDiscardDetached" })}
            />
            <span>{intl.formatMessage({ id: "worktree.remove.confirmDiscardDetached" })}</span>
          </label>
        ) : null}

        {state.phase === "result-unknown" ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-ui-base text-warning">
              {intl.formatMessage({ id: "worktree.remove.resultUnknown" })}
            </p>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "worktree.remove.resultUnknownHint" })}
            </p>
          </div>
        ) : null}
        {state.phase === "error" && state.errorMessage ? (
          <p role="alert" className="text-ui-base text-danger">
            {intl.formatMessage({ id: "worktree.remove.failed" }, { error: state.errorMessage })}
          </p>
        ) : null}
      </div>
      <DialogFooter className="gap-2 px-6 pb-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        {state.phase === "result-unknown" ? (
          <Button type="button" variant="outline" onClick={onRetryUnknown}>
            {intl.formatMessage({ id: "worktree.remove.retryUnknown" })}
          </Button>
        ) : null}
        {state.phase === "error" || block === "unreachable" || block === "risk-unknown" ? (
          <Button type="button" variant="outline" onClick={onRetry} disabled={busy}>
            {intl.formatMessage({ id: "worktree.remove.retry" })}
          </Button>
        ) : null}
        {preview && !block && state.phase === "confirm" ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirmWorktreeRemoval(state)}
            onClick={onConfirm}
          >
            {intl.formatMessage({ id: "worktree.remove.confirm" })}
          </Button>
        ) : null}
        {busy ? (
          <Button type="button" variant="destructive" disabled>
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "worktree.remove.removing" })}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function RemoveWorktreeDialog(props: RemoveWorktreeDialogProps) {
  const { open, ...bodyProps } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && bodyProps.state.phase !== "removing") bodyProps.onCancel();
      }}
    >
      <DialogContent
        showCloseButton={bodyProps.state.phase !== "removing"}
        aria-describedby={undefined}
        className="max-w-xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <RemoveWorktreeDialogBody {...bodyProps} />
      </DialogContent>
    </Dialog>
  );
}
