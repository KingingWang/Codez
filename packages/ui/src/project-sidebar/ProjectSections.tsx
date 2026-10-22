import type { ReactNode } from "react";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
import type {
  ProjectSidebarProps,
  ProjectTree,
  RemoteProjectDirectory,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { selectProjectRows } from "@/project-sidebar/view.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { PurposeSections } from "@/project-sidebar/PurposeSections.js";
export function ProjectSections({
  tree,
  projects,
  directory,
  renderProject,
  onSelect,
  refresh,
  onCreate,
  onAddProject,
  hasExpandedProjects,
  canToggleProjects,
  onToggleProjects,
  onReorder,
  loading,
}: {
  tree: ProjectTree;
  projects: VirtualProject[];
  directory: RemoteProjectDirectory;
  renderProject(project: VirtualProject): ReactNode;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(): void;
  onAddProject(): void;
  hasExpandedProjects: boolean;
  canToggleProjects: boolean;
  onToggleProjects(): void;
  onReorder(active: string, over: string): void;
  loading: boolean;
}) {
  const retainedHosts = new Set(directory.hosts.map((host) => host.id));
  // 修复原因（issue #19）：侧栏「任务」分区需展示本机及所有已连接远程机器上的全部非置顶、
  // 非归档 Codex 会话（包含各项目会话及未建项目目录下的外部 CLI 会话），而非仅展示默认目录的
  // project_id=NULL 本地会话。离线或已移除的远程 Host 已在 mergeProjectTrees 中剔除。
  const allTasks = selectProjectRows(tree, { kind: "timeline" }).filter(
    (task) => !task.pinned && (task.hostId === "local" || retainedHosts.has(task.hostId)),
  );
  return (
    <PurposeSections
      onAdd={onAddProject}
      hasExpandedProjects={hasExpandedProjects}
      canToggleProjects={canToggleProjects}
      onToggleProjects={onToggleProjects}
      onCreate={onCreate}
      projects={
        <SortableProjects
          projects={projects.filter((project) => !project.pinned)}
          renderProject={renderProject}
          onReorder={onReorder}
        />
      }
      tasks={
        // 原因：任务分区遗漏项目内列表的左侧留白，导致整行背景和文字贴左；统一内缩 8px。
        <div className="pl-2">
          <ProjectTaskRows
            tasks={allTasks}
            onSelect={onSelect}
            refresh={refresh}
            showEmptyState={!loading}
          />
        </div>
      }
    />
  );
}
