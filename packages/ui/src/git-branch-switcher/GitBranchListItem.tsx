import type { GitLocalBranch } from "@codez/shared";
import { CommandItem } from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { GitBranchIcon, Trash2Icon } from "lucide-react";

interface GitBranchListItemProps {
  branch: GitLocalBranch;
  isCurrent: boolean;
  /** 当前分支的脏文件计数文案；非当前分支忽略。 */
  currentBranchDirtyLabel: string | null;
  disabled: boolean;
  onSelect: (branchName: string) => void;
  /** 提供删除能力时渲染行尾删除入口；为 null 时（如无项目分组）不渲染。 */
  onDeleteBranch: ((branchName: string) => void) | null;
}

export function GitBranchListItem({
  branch,
  isCurrent,
  currentBranchDirtyLabel,
  disabled,
  onSelect,
  onDeleteBranch,
}: GitBranchListItemProps) {
  const { intl } = useCodezIntl();
  return (
    <CommandItem
      value={branch.name}
      data-checked={isCurrent ? "true" : undefined}
      data-branch-current={isCurrent ? "true" : undefined}
      disabled={disabled}
      className={cn("items-start gap-3 rounded-lg px-3 py-2 text-ui-base")}
      onSelect={() => {
        onSelect(branch.name);
      }}
    >
      <GitBranchIcon className="mt-0.5 size-4 text-foreground-subtle" />
      <div className="min-w-0 flex-1 flex flex-col gap-1 text-left">
        <div className="truncate text-ui-base font-medium text-foreground">{branch.name}</div>
        {isCurrent && currentBranchDirtyLabel ? (
          <p className="pt-0.5 text-ui-base text-foreground-subtle">{currentBranchDirtyLabel}</p>
        ) : null}
        {!isCurrent && branch.worktreePath ? (
          <p
            className="truncate pt-0.5 text-ui-base text-foreground-subtle"
            title={branch.worktreePath}
          >
            {intl.formatMessage(
              { id: "git.branchSwitcher.checkedOutAt" },
              {
                path: branch.worktreePath.split("/").filter(Boolean).pop() ?? branch.worktreePath,
              },
            )}
          </p>
        ) : null}
      </div>
      {!isCurrent && onDeleteBranch ? (
        <button
          type="button"
          aria-label={intl.formatMessage(
            { id: "git.branchDelete.action" },
            { branch: branch.name },
          )}
          title={intl.formatMessage({ id: "git.branchDelete.action" }, { branch: branch.name })}
          className="mt-0.5 shrink-0 rounded p-1 text-foreground-subtle hover:bg-menu-hover hover:text-danger"
          onMouseDown={(event) => {
            // 不截断会让 cmdk 把点击当成行选择（切换分支）。
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onDeleteBranch(branch.name);
          }}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      ) : null}
    </CommandItem>
  );
}
