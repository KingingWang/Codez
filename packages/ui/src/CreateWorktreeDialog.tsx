import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { AlertCircleIcon, CheckCircle2Icon, LoaderIcon } from "lucide-react";
import type {
  WorktreeCreationAvailability,
  WorktreeCreationFormState,
  WorktreeCreationMode,
} from "./hooks/useWorktreeCreation.js";

export interface CreateWorktreeDialogProps {
  open: boolean;
  workspacePath: string;
  state: WorktreeCreationFormState;
  availability: WorktreeCreationAvailability | "waiting";
  disabledReason: null | string;
  onModeChange: (mode: WorktreeCreationMode) => void;
  onBranchNameChange: (value: string) => void;
  onStartPointChange: (value: string) => void;
  onTargetPathChange: (value: string) => void;
  onSubmit: () => void;
  onRetryOpen: () => void;
  onCancel: () => void;
  onOpenOccupied: (path: string) => void;
}

function BranchModeButton({
  active,
  disabled,
  label,
  description,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
        active
          ? "border-brand bg-accent text-foreground"
          : "border-border bg-input text-foreground hover:border-border-hover",
      )}
    >
      <span className="text-ui-base font-medium">{label}</span>
      <span className="text-ui-sm text-foreground-subtle">{description}</span>
    </button>
  );
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

export function CreateWorktreeDialogBody({
  workspacePath,
  state,
  availability,
  disabledReason,
  onModeChange,
  onBranchNameChange,
  onStartPointChange,
  onTargetPathChange,
  onSubmit,
  onRetryOpen,
  onCancel,
  onOpenOccupied,
}: Omit<CreateWorktreeDialogProps, "open">) {
  const { intl } = useCodezIntl();
  // 结果未知只冻结编辑，不能同时禁用同操作重试；原请求由 hook 保留，后端按记录复检。
  const locked = state.pending || state.phase === "create-unknown";
  const created = state.phase === "created" || state.phase === "opened";
  const preview = state.preview;
  const branchNameId = "worktree-create-branch-name";
  const targetPathId = "worktree-create-target-path";
  const startPointItems = state.branches;

  return (
    <div className="grid w-full max-w-xl gap-0 overflow-hidden rounded-2xl bg-popover p-0 text-ui-base text-foreground">
      <DialogHeader className="gap-1 px-6 pt-6">
        <h2 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "worktree.create.title" })}
        </h2>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.create.description" }, { workspacePath })}
        </p>
      </DialogHeader>

      <div className="max-h-[65vh] space-y-5 overflow-y-auto px-6 py-6">
        {disabledReason ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{disabledReason}</span>
          </div>
        ) : null}

        {state.phase === "create-unknown" ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{intl.formatMessage({ id: "worktree.create.unknown.title" })}</span>
          </div>
        ) : null}

        {state.error ? (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
            {state.error === "worktree.create.error.unsupported"
              ? intl.formatMessage({ id: state.error })
              : intl.formatMessage(
                  { id: "worktree.create.error.requestFailed" },
                  { error: state.error },
                )}
          </div>
        ) : null}

        {created ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-ui-base text-success">
              {state.phase === "opened" ? (
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
              ) : (
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                {state.phase === "opened"
                  ? intl.formatMessage({ id: "worktree.create.opened" })
                  : intl.formatMessage({ id: "worktree.create.createdOpenFailed" })}
              </span>
            </div>
            {state.result ? (
              <FactRow
                label={intl.formatMessage({ id: "worktree.create.preview.path" })}
                value={state.result.workspacePath}
              />
            ) : null}
            {state.openError ? (
              <p className="text-ui-base text-destructive">
                {intl.formatMessage(
                  { id: "worktree.create.openFailed" },
                  { error: state.openError },
                )}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <fieldset className="space-y-2" disabled={locked}>
              <legend className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "worktree.create.mode.label" })}
              </legend>
              <div className="flex flex-col gap-2 sm:flex-row">
                <BranchModeButton
                  active={state.mode === "new-branch"}
                  disabled={locked}
                  label={intl.formatMessage({ id: "worktree.create.mode.new" })}
                  description={intl.formatMessage({ id: "worktree.create.mode.newDescription" })}
                  onClick={() => onModeChange("new-branch")}
                />
                <BranchModeButton
                  active={state.mode === "existing-branch"}
                  disabled={locked}
                  label={intl.formatMessage({ id: "worktree.create.mode.existing" })}
                  description={intl.formatMessage({
                    id: "worktree.create.mode.existingDescription",
                  })}
                  onClick={() => onModeChange("existing-branch")}
                />
              </div>
            </fieldset>

            <div className="space-y-2">
              <label htmlFor={branchNameId} className="text-ui-base font-medium text-foreground">
                {state.mode === "new-branch"
                  ? intl.formatMessage({ id: "worktree.create.branchName.label" })
                  : intl.formatMessage({ id: "worktree.create.existingBranch.label" })}
              </label>
              {state.mode === "new-branch" ? (
                <Input
                  id={branchNameId}
                  value={state.branchName}
                  disabled={locked}
                  autoComplete="off"
                  placeholder={intl.formatMessage({ id: "worktree.create.branchName.placeholder" })}
                  onChange={(event) => onBranchNameChange(event.target.value)}
                />
              ) : (
                <Select
                  value={state.branchName || undefined}
                  disabled={locked}
                  onValueChange={onBranchNameChange}
                >
                  <SelectTrigger id={branchNameId} className="w-full" size="lg">
                    <SelectValue
                      placeholder={intl.formatMessage({
                        id: "worktree.create.existingBranch.placeholder",
                      })}
                    />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-56">
                    {startPointItems.map((branch) => (
                      <SelectItem
                        key={branch.name}
                        value={branch.name}
                        disabled={Boolean(branch.worktreePath)}
                      >
                        {branch.name}
                        {branch.worktreePath ? (
                          <span className="max-w-48 truncate font-mono text-ui-sm text-foreground-subtlest">
                            {branch.worktreePath}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {state.mode === "new-branch" ? (
              <div className="space-y-2">
                <label
                  htmlFor="worktree-create-start-point"
                  className="text-ui-base font-medium text-foreground"
                >
                  {intl.formatMessage({ id: "worktree.create.startPoint.label" })}
                </label>
                <Select
                  value={state.startPoint || state.currentBranchName || "HEAD"}
                  disabled={locked}
                  onValueChange={onStartPointChange}
                >
                  <SelectTrigger id="worktree-create-start-point" className="w-full" size="lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-56">
                    <SelectItem value={state.currentBranchName ?? "HEAD"}>
                      {state.currentBranchName
                        ? intl.formatMessage(
                            { id: "worktree.create.currentHead" },
                            { branch: state.currentBranchName },
                          )
                        : "HEAD"}
                    </SelectItem>
                    {startPointItems.map((branch) => (
                      <SelectItem key={branch.name} value={branch.name}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-2">
              <label htmlFor={targetPathId} className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "worktree.create.targetPath.label" })}
              </label>
              <Input
                id={targetPathId}
                value={state.targetPath}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  preview?.targetPath ??
                  intl.formatMessage({ id: "worktree.create.targetPath.placeholder" })
                }
                onChange={(event) => onTargetPathChange(event.target.value)}
              />
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.create.targetPath.helper" })}
              </p>
            </div>

            {preview ? (
              <section className="space-y-2 rounded-xl border border-border bg-card p-3">
                <h3 className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "worktree.create.preview.title" })}
                </h3>
                <FactRow
                  label={intl.formatMessage({ id: "worktree.create.preview.startPoint" })}
                  value={preview.startPoint}
                />
                <FactRow
                  label={intl.formatMessage({ id: "worktree.create.preview.baseline" })}
                  value={preview.baselineCommit}
                />
                <FactRow
                  label={intl.formatMessage({ id: "worktree.create.preview.path" })}
                  value={state.targetPathTouched ? state.targetPath : preview.targetPath}
                />
                {state.occupiedPath ? (
                  <div className="space-y-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
                    <p>
                      {intl.formatMessage(
                        { id: "worktree.create.occupied" },
                        { branch: state.branchName, path: state.occupiedPath },
                      )}
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenOccupied(state.occupiedPath ?? "")}
                    >
                      {intl.formatMessage({ id: "worktree.create.openOccupied" })}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : (
              <p className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                {state.previewPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                {intl.formatMessage({
                  id: state.previewPending
                    ? "worktree.create.preview.pending"
                    : "worktree.create.preview.waitingInput",
                })}
              </p>
            )}

            <section className="space-y-1 rounded-xl bg-background/40 px-3 py-2 text-ui-sm text-foreground-subtle">
              <p>{intl.formatMessage({ id: "worktree.create.disclosure.dirty" })}</p>
              <p>{intl.formatMessage({ id: "worktree.create.disclosure.env" })}</p>
            </section>
          </>
        )}
      </div>

      <DialogFooter className="px-6 pb-6">
        {state.phase === "created" || state.phase === "opened" ? (
          <>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={state.pending}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
            {state.phase === "created" ? (
              <Button type="button" onClick={onRetryOpen} disabled={state.pending}>
                {state.pending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                {intl.formatMessage({ id: "worktree.create.retryOpen" })}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={state.pending}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              onClick={onSubmit}
              disabled={
                state.pending || Boolean(state.occupiedPath) || !preview || availability !== "ready"
              }
            >
              {state.pending ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {state.phase === "create-unknown"
                ? intl.formatMessage({ id: "worktree.create.unknown.retry" })
                : state.pending
                  ? intl.formatMessage({ id: "worktree.create.creating" })
                  : intl.formatMessage({ id: "worktree.create.submit" })}
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

export function CreateWorktreeDialog({ open, ...bodyProps }: CreateWorktreeDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !bodyProps.state.pending) bodyProps.onCancel();
      }}
    >
      <DialogContent
        showCloseButton={!bodyProps.state.pending}
        aria-describedby={undefined}
        className="max-w-xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <CreateWorktreeDialogBody {...bodyProps} />
      </DialogContent>
    </Dialog>
  );
}
