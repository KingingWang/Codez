import { createContext, useContext, type ReactNode } from "react";
import { FolderOpen, GitFork } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { WorktreeExistingMenuItems } from "@/WorktreeSessionMenu.js";

export interface GitWorktreeMenuValue {
  workspacePath: string;
  workspaceIdentity?: string | null;
  disabledReason?: string | null;
  entries: WorktreeDiscoveryEntry[];
  allowOpenWorkspace: boolean;
  onCreate: () => void;
  onOpenEntry: (entry: WorktreeDiscoveryEntry) => void;
  onRefresh: () => void;
}

const GitWorktreeMenuContext = createContext<GitWorktreeMenuValue | null>(null);

/** 只传递 shell 已有命令与投影；不持有创建状态，不建立新的服务调用路径。 */
export function GitWorktreeMenuProvider({
  value,
  children,
}: {
  value: GitWorktreeMenuValue;
  children: ReactNode;
}) {
  return (
    <GitWorktreeMenuContext.Provider value={value}>{children}</GitWorktreeMenuContext.Provider>
  );
}

export function useGitWorktreeMenu(
  workspacePath: string,
  workspaceIdentity?: string | null,
): GitWorktreeMenuValue | null {
  const value = useContext(GitWorktreeMenuContext);
  // 分屏与远端可能显示同路径：必须同时复核目标身份，不能借用当前树的创建控制器。
  if (
    !value ||
    value.workspacePath !== workspacePath ||
    (value.workspaceIdentity?.trim() || value.workspacePath) !==
      (workspaceIdentity?.trim() || workspacePath)
  ) {
    return null;
  }
  return value;
}

export function GitWorktreeMenuActions({
  workspacePath,
  workspaceIdentity,
  disabled = false,
  onBeforeAction,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  disabled?: boolean;
  onBeforeAction: () => void;
}) {
  const { intl } = useCodezIntl();
  const menu = useGitWorktreeMenu(workspacePath, workspaceIdentity);
  if (!menu) {
    return null;
  }
  const buttonClass =
    "w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground";
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className={`${buttonClass} h-auto min-h-8 items-start`}
        disabled={disabled || Boolean(menu.disabledReason)}
        onClick={() => {
          onBeforeAction();
          menu.onCreate();
        }}
      >
        <GitFork className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
          <span>{intl.formatMessage({ id: "git.branchSwitcher.createWorktreeAction" })}</span>
          {menu.disabledReason ? <span className="text-ui-xs">{menu.disabledReason}</span> : null}
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className={buttonClass}
            disabled={disabled}
          >
            <FolderOpen className="size-4 text-foreground-subtle" />
            {intl.formatMessage({ id: "git.branchSwitcher.openWorktreeAction" })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          <WorktreeExistingMenuItems
            entries={menu.entries}
            allowOpenWorkspace={menu.allowOpenWorkspace}
            onOpenEntry={(entry) => {
              onBeforeAction();
              menu.onOpenEntry(entry);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
