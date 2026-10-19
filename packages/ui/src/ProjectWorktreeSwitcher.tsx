import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  normalizeWorkspacePathForComparison,
  type WorktreeDiscoveryEntry,
} from "@/lib/projectGrouping.js";
import {
  resolveWorktreeDirName,
  resolveWorktreeSwitcherAction,
} from "@/lib/worktreeSwitcherDisplay.js";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitForkIcon,
  LockIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

/**
 * 独立工作区切换器（specs/git-worktree-projects.md 阶段一）。
 * 列出当前项目 git 台账里的全部工作树（含未打开的轻量条目），
 * 显式点击才经 onOpenEntry 走 root 的三意图打开编排；本组件自身
 * 只读展示，不注册工作区、不挂载运行时、不建立连接。
 */

interface ProjectWorktreeSwitcherProps {
  /** 当前激活工作区路径（用于"当前"与"打开仓库根目录"判定）。 */
  workspacePath: string;
  entries: WorktreeDiscoveryEntry[];
  /** 最近一次台账读取瞬时失败（R14：不可达提供重试）。 */
  isRefreshFailed: boolean;
  allowOpenWorkspace: boolean;
  onOpenEntry: (entry: WorktreeDiscoveryEntry) => void;
  onRefresh: () => void;
  /** 行尾删除入口（IA4）：主目录不渲染；门控统一在删除确认弹层内解释。 */
  onRemoveEntry?: (entry: WorktreeDiscoveryEntry) => void;
  /** 底部新建入口（IA2）：与分支菜单入口指向同一创建对话框。 */
  onCreateWorktree?: () => void;
  createDisabledReason?: string | null;
  className?: string;
  popoverClassName?: string;
  popoverSide?: "top" | "bottom" | "left" | "right";
}

export function ProjectWorktreeSwitcher({
  workspacePath,
  entries,
  isRefreshFailed,
  allowOpenWorkspace,
  onOpenEntry,
  onRefresh,
  onRemoveEntry,
  onCreateWorktree,
  createDisabledReason,
  className,
  popoverClassName,
  popoverSide = "top",
}: ProjectWorktreeSwitcherProps) {
  const { intl } = useCodezIntl();
  const [open, setOpen] = useState(false);

  // 展开菜单是显式刷新时机（R5：发现列表随显式动作刷新，不后台轮询）。
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        onRefresh();
      }
    },
    [onRefresh],
  );

  const normalizedCurrentPath = normalizeWorkspacePathForComparison(workspacePath);
  const triggerLabel = resolveWorktreeDirName(normalizedCurrentPath);

  return (
    <div className={cn("flex items-center px-1 pt-2", className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label={intl.formatMessage(
              { id: "worktree.switcher.trigger.ariaLabel" },
              { count: String(entries.length) },
            )}
            title={intl.formatMessage(
              { id: "worktree.switcher.trigger.ariaLabel" },
              { count: String(entries.length) },
            )}
            className="min-w-0 max-w-full rounded-full pl-3 pr-2 text-ui-base/relaxed"
          >
            <FolderGit2Icon className="size-4 text-foreground-subtle" />
            <span className="min-w-0 max-w-25 truncate text-left">{triggerLabel}</span>
            <span className="shrink-0 text-ui-sm text-foreground-subtle">{entries.length}</span>
            <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={popoverSide}
          className={cn("w-80 gap-0 bg-menu p-0", popoverClassName)}
          onOpenAutoFocus={(event) => {
            // 列表很短、无搜索框；默认 autofocus 会让首项抢焦点，保持触发器焦点即可。
            event.preventDefault();
          }}
        >
          <Command className="bg-transparent p-0 text-foreground">
            <CommandList className="max-h-72">
              <CommandGroup
                heading={intl.formatMessage({ id: "worktree.switcher.section" })}
                className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {entries.map((entry) => {
                  const action = resolveWorktreeSwitcherAction({
                    entry,
                    currentWorkspacePath: normalizedCurrentPath,
                    allowOpenWorkspace,
                  });
                  const isCurrent =
                    normalizeWorkspacePathForComparison(entry.path) === normalizedCurrentPath;
                  const dirName = resolveWorktreeDirName(entry.path);
                  const branchLabel =
                    entry.branchName ??
                    (entry.isDetached ? intl.formatMessage({ id: "git.head.detached" }) : null);
                  return (
                    <CommandItem
                      key={entry.path}
                      value={entry.path}
                      disabled={action === "disabled"}
                      className={cn("items-start gap-3 rounded-lg px-3 py-2 text-ui-base")}
                      onSelect={() => {
                        setOpen(false);
                        onOpenEntry(entry);
                      }}
                    >
                      <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-ui-base font-medium text-foreground">
                            {dirName}
                          </span>
                          {isCurrent ? (
                            <span className="shrink-0 text-ui-sm text-foreground-subtle">
                              {intl.formatMessage({ id: "worktree.switcher.current" })}
                            </span>
                          ) : action === "activate" ? (
                            <span className="shrink-0 text-ui-sm text-foreground-subtle">
                              {intl.formatMessage({ id: "worktree.switcher.open" })}
                            </span>
                          ) : null}
                          {entry.isMain ? (
                            <span className="shrink-0 text-ui-sm text-foreground-subtle">
                              {intl.formatMessage({ id: "worktree.switcher.mainTree" })}
                            </span>
                          ) : null}
                        </div>
                        {branchLabel ? (
                          <div className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
                            <GitBranchIcon className="size-3 shrink-0" />
                            <span className="truncate">{branchLabel}</span>
                          </div>
                        ) : null}
                        <div
                          className="truncate text-ui-sm text-foreground-subtle"
                          title={entry.path}
                        >
                          {entry.path}
                        </div>
                        {entry.isLocked ? (
                          <div
                            className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle"
                            title={entry.lockReason ?? undefined}
                          >
                            <LockIcon className="size-3 shrink-0" />
                            <span className="truncate">
                              {intl.formatMessage({ id: "worktree.switcher.locked" })}
                              {entry.lockReason ? `：${entry.lockReason}` : ""}
                            </span>
                          </div>
                        ) : null}
                        {entry.isPrunable ? (
                          <div
                            className="flex min-w-0 items-center gap-1 text-ui-sm text-warning"
                            title={entry.prunableReason ?? undefined}
                          >
                            <AlertTriangleIcon className="size-3 shrink-0" />
                            <span className="truncate">
                              {intl.formatMessage({ id: "worktree.switcher.unreachable" })}
                            </span>
                          </div>
                        ) : null}
                        {action === "open-root" ? (
                          <div className="text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({ id: "worktree.switcher.openRootAction" })}
                          </div>
                        ) : null}
                        {action === "disabled" ? (
                          <div className="text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({ id: "worktree.open.unsupported" })}
                          </div>
                        ) : null}
                      </div>
                      {!entry.isMain && onRemoveEntry ? (
                        <button
                          type="button"
                          aria-label={intl.formatMessage({ id: "worktree.remove.action" })}
                          title={intl.formatMessage({ id: "worktree.remove.action" })}
                          className="mt-0.5 shrink-0 rounded p-1 text-foreground-subtle hover:bg-menu-hover hover:text-danger"
                          onMouseDown={(event) => {
                            // 不截断会让 cmdk 把点击当成行选择（打开工作区）。
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpen(false);
                            onRemoveEntry(entry);
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          {onCreateWorktree ? (
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                disabled={Boolean(createDisabledReason)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-base text-foreground hover:bg-menu-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setOpen(false);
                  onCreateWorktree();
                }}
              >
                <GitForkIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1">
                  {intl.formatMessage({ id: "worktree.menu.new" })}
                  {createDisabledReason ? (
                    <span className="block text-ui-sm text-foreground-subtle">
                      {createDisabledReason}
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
          ) : null}
          {isRefreshFailed ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-border/50 px-3 py-2 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
              onClick={() => onRefresh()}
            >
              <RefreshCwIcon className="size-3.5 shrink-0" />
              {intl.formatMessage({ id: "worktree.switcher.refreshFailed" })}
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
