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
  /** 只返回这些会话（例如分享管理按来源会话 ID 解析跳转目标）；空数组返回空结果。 */
  taskIds?: readonly string[];
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
