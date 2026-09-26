import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitRepositorySummary } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "./ConversationStatusPanel.js";

const gitSummary: GitRepositorySummary = {
  workspacePath: "/fixture/project",
  repoRoot: "/fixture/project",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: "origin/main",
  headRefType: "branch",
  ahead: 1,
  behind: 0,
  isDirty: false,
  isGitAvailable: true,
  isRepository: true,
};

test("clean repository keeps a visible collapsed Git tools entry", () => {
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ConversationStatusPanel
          workspacePath="/fixture/project"
          gitSummary={gitSummary}
          gitWorktreeChangeSummary={{ added: 0, removed: 0 }}
          summaryPanelVariantOverride="mini"
          onRefreshGit={() => {}}
        />
      </TooltipProvider>
    </CodezIntlProvider>,
  );
  assert.match(html, /aria-label="状态"/);
  assert.match(html, /Git 工具/);
  assert.match(html, /aria-label="展开状态"/);
});

test("ahead repository displays commit or push in the expanded Git tools section", () => {
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ServiceProvider services={{ gitService: {} } as IServiceAccessor}>
          <ConversationStatusPanel
            workspacePath="/fixture/project"
            gitSummary={gitSummary}
            gitWorktreeChangeSummary={{ added: 0, removed: 0 }}
            summaryPanelVariantOverride="panel"
            onRefreshGit={() => {}}
          />
        </ServiceProvider>
      </TooltipProvider>
    </CodezIntlProvider>,
  );
  assert.match(html, /Git 工具/);
  assert.match(html, /提交或推送/);
});
