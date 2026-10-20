import { GitBranchIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  canConfirmBranchDeletion,
  resolveBranchDeletionBlock,
  type BranchDeletionState,
} from "./hooks/branchDeletionModel.js";

/**
 * 删除本地分支确认弹层（specs/git-worktree-removal.md B 系列）。
 * 纯展示组件：占用/合并门控走 branchDeletionModel 纯函数。
 */

export interface DeleteBranchDialogProps {
  open: boolean;
  state: BranchDeletionState;
  onForceConfirmedChange: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 明确失败后的重试：重新预检。 */
  onRetry: () => void;
  /** 占用阻塞态跳转到检出该分支的工作区。 */
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

export function DeleteBranchDialogBody({
  state,
  onForceConfirmedChange,
  onConfirm,
  onCancel,
  onRetry,
  onJumpToWorkspace,
}: Omit<DeleteBranchDialogProps, "open">) {
  const { intl } = useCodezIntl();
  const preview = state.preview;
  const block = preview ? resolveBranchDeletionBlock(preview) : null;
  const busy = state.phase === "deleting";
  const needsForce = preview ? preview.isMerged !== true : false;

  return (
    <>
      <DialogHeader className="gap-1 px-6 pt-6">
        <span className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "git.branchDelete.title" })}
        </span>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "git.branchDelete.description" },
            { branch: preview?.branchName ?? "" },
          )}
        </span>
      </DialogHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-6 py-4">
        {state.phase === "previewing" ? (
          <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "git.branchDelete.previewPending" })}
          </div>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-2">
            <FactRow
              label={intl.formatMessage({ id: "git.branchDelete.branch" })}
              value={preview.branchName}
            />
            <FactRow
              label={intl.formatMessage({ id: "git.branchDelete.lastCommit" })}
              value={`${preview.commitHash?.slice(0, 7) ?? "?"} ${preview.commitSubject ?? ""}`.trim()}
            />
            <FactRow
              label={intl.formatMessage({ id: "git.branchDelete.mergeState" })}
              value={intl.formatMessage({
                id:
                  preview.isMerged === true
                    ? "git.branchDelete.merged"
                    : preview.isMerged === false
                      ? "git.branchDelete.unmerged"
                      : "git.branchDelete.mergeUnknown",
              })}
            />
          </div>
        ) : null}

        {state.notice === "branch-moved" ? (
          <p role="status" className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "git.branchDelete.moved" })}
          </p>
        ) : null}

        {block === "current" ? (
          <p role="alert" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "git.branchDelete.blocked.current" })}
          </p>
        ) : null}
        {block === "occupied" && preview?.checkedOutPath ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "git.branchDelete.occupied" },
                { path: preview.checkedOutPath },
              )}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => preview.checkedOutPath && onJumpToWorkspace(preview.checkedOutPath)}
              >
                <GitBranchIcon className="size-3.5" />
                {intl.formatMessage({ id: "worktree.create.openOccupied" })}
              </Button>
            </div>
          </div>
        ) : null}

        {preview && !block && needsForce ? (
          <label className="flex cursor-pointer items-start gap-2 text-ui-base text-foreground">
            <Checkbox
              checked={state.forceConfirmed}
              onCheckedChange={(checked) => onForceConfirmedChange(checked === true)}
              aria-label={intl.formatMessage({ id: "git.branchDelete.confirmForce" })}
            />
            <span>{intl.formatMessage({ id: "git.branchDelete.confirmForce" })}</span>
          </label>
        ) : null}

        {state.phase === "error" && state.errorMessage ? (
          <p role="alert" className="text-ui-base text-danger">
            {intl.formatMessage({ id: "git.branchDelete.failed" }, { error: state.errorMessage })}
          </p>
        ) : null}
      </div>
      <DialogFooter className="gap-2 px-6 pb-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        {state.phase === "error" ? (
          <Button type="button" variant="outline" onClick={onRetry} disabled={busy}>
            {intl.formatMessage({ id: "worktree.remove.retry" })}
          </Button>
        ) : null}
        {preview && !block && state.phase === "confirm" ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirmBranchDeletion(state)}
            onClick={onConfirm}
          >
            {intl.formatMessage({ id: "git.branchDelete.confirm" })}
          </Button>
        ) : null}
        {busy ? (
          <Button type="button" variant="destructive" disabled>
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "git.branchDelete.deleting" })}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function DeleteBranchDialog(props: DeleteBranchDialogProps) {
  const { open, ...bodyProps } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && bodyProps.state.phase !== "deleting") bodyProps.onCancel();
      }}
    >
      <DialogContent
        showCloseButton={bodyProps.state.phase !== "deleting"}
        aria-describedby={undefined}
        className="max-w-xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <DeleteBranchDialogBody {...bodyProps} />
      </DialogContent>
    </Dialog>
  );
}
