import type { WorkspacePurpose, CodezTaskMeta } from "@codez/shared";

export type CodezTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type CodezTaskListSortBy = "created" | "updated";

export interface CodezTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface CodezTaskListQuery {
  kind: CodezTaskListKind;
  workspaceScopes: CodezTaskListWorkspaceScope[];
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

export type CodezTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface CodezTaskGroup {
  id: string;
  title: string;
  color: CodezTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface CodezGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type CodezGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: CodezGroupedTaskRef };

export type CodezGroupedTaskViewNode =
  | {
      type: "group";
      group: CodezTaskGroup;
      tasks: CodezTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: CodezTaskListItem;
      sortOrder?: number;
    };

export interface CodezGroupedTaskView {
  nodes: CodezGroupedTaskViewNode[];
}

export interface CodezGroupedTaskViewQuery {
  workspaceScopes: CodezTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface CodezGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type CodezGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface CodezGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: CodezTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: CodezGroupedTaskViewStructureMember[];
  topLevelOrders: CodezGroupedTaskViewStructureTopOrder[];
}

export interface CodezGroupedTaskViewOrderInput {
  workspaceScopes: CodezTaskListWorkspaceScope[];
  topLevelNodes: CodezGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: CodezGroupedTaskRef[];
  }>;
}

export interface CodezWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
