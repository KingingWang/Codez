import { createContext, useContext, type ReactNode } from "react";
import { GitFork } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";

export interface GitWorktreeMenuValue {
  workspacePath: string;
  workspaceIdentity?: string | null;
  disabledReason?: string | null;
  onCreate: () => void;
  onRefresh: () => void;
  /** 分支行尾删除入口（specs/git-worktree-removal.md B1）：shell 持有的删除编排。 */
  onDeleteBranch?: (branchName: string) => void;
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
    </>
  );
}
