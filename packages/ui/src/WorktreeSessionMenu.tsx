import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { useEffect } from "react";

/** 只展示轻量条目；打开菜单不会注册工作区、连接或草稿。 */
export function WorktreeSessionMenu({
  onCreateCurrent,
  onCreateWorktree,
  disabledReason,
  entries,
  onOpenEntry,
  allowOpenWorkspace,
  onRefresh,
}: {
  onCreateCurrent: () => void;
  onCreateWorktree: () => void;
  disabledReason: string | null;
  entries: WorktreeDiscoveryEntry[];
  onOpenEntry: (entry: WorktreeDiscoveryEntry) => void;
  allowOpenWorkspace: boolean;
  onRefresh: () => void;
}) {
  const { intl } = useCodezIntl();
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);
  return (
    <>
      <DropdownMenuItem onSelect={onCreateCurrent}>
        {intl.formatMessage({ id: "worktree.menu.current" })}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={Boolean(disabledReason)}
        onSelect={onCreateWorktree}
        className="flex-col items-start gap-0.5"
      >
        <span>{intl.formatMessage({ id: "worktree.menu.new" })}</span>
        {disabledReason ? <span className="max-w-64 text-ui-xs">{disabledReason}</span> : null}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {intl.formatMessage({ id: "worktree.menu.existing" })}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-w-80">
          {entries.length === 0 ? (
            <DropdownMenuItem disabled>
              {intl.formatMessage({ id: "worktree.menu.unavailable" })}
            </DropdownMenuItem>
          ) : (
            entries.map((entry) => (
              <DropdownMenuItem
                key={entry.path}
                disabled={!allowOpenWorkspace && !entry.isOpen}
                onSelect={() => onOpenEntry(entry)}
                className="flex-col items-start gap-0.5"
              >
                <span className="max-w-full truncate">{entry.branchName ?? entry.path}</span>
                <span
                  className="max-w-full truncate text-ui-xs text-foreground-subtle"
                  title={entry.path}
                >
                  {entry.path}
                </span>
                {!allowOpenWorkspace && !entry.isOpen ? (
                  <span className="text-ui-xs">
                    {intl.formatMessage({ id: "worktree.open.unsupported" })}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
