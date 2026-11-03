import type { WorkspacePurpose, CodezTaskMeta } from "@codez/shared";

export type CodezTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type CodezTaskListSortBy = "created" | "updated";

export interface CodezTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface CodezTaskListQuery {
  kind: CodezTaskListKind | "all";
  /** host 由存储 owner 确定全部范围，不接受 UI 已打开工作区作为历史目录。 */
  workspaceScopes: CodezTaskListWorkspaceScope[] | "host";
  sortBy: CodezTaskListSortBy;
  search?: string;
  limit?: number;
}

export type CodezTaskListItem = CodezTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface CodezTaskListResult {
  items: CodezTaskListItem[];
  total: number;
  hasMore: boolean;
}

export interface CodezWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
