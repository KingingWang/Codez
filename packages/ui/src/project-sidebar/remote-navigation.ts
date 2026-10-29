import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";
import { REMOTE_BIND_CANCELED_ERROR_CODE } from "@/project-sidebar/contract.js";

export function isProjectNavigationCanceledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "remote-connection-canceled" ||
      (error as { code?: unknown }).code === REMOTE_BIND_CANCELED_ERROR_CODE ||
      (error as { name?: unknown }).name === "AbortError")
  );
}

/** 连接实例归 Host；这里只申请/绑定 logical attachment，不按 path 复用另一台设备的 scope。 */
export async function attachRemoteProjectWorkspace(input: {
  hostId: string;
  workspacePath: string;
  workspaceIdentity: string;
  expectedMembershipId?: string;
  projectId?: string | null;
  projectService?: Pick<IProjectService, "readProjects">;
  remoteService: IRemoteProjectService;
  isCurrent?(): boolean;
  findSession(identity: string, expectedSessionId?: string): { sessionId: string } | undefined;
  connect: ProjectSidebarProps["onConnectRemote"];
  bind(
    sessionId: string,
    path: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ): Promise<void>;
  cancel: ProjectSidebarProps["onCancelRemoteProject"];
}): Promise<string> {
  const assertCurrent = () => {
    // 连续点击使旧导航正常失效；结构化取消与真实连接/身份失败必须分开，避免瞬时错误 toast。
    if (input.isCurrent?.() === false)
      throw Object.assign(new Error("project.navigation-cancelled"), {
        code: "remote-connection-canceled",
      });
  };
  assertCurrent();
  const host = await input.remoteService.connectHost(input.hostId);
  assertCurrent();
  if (host.id !== input.hostId || !host.target) throw new Error("project.host-identity-changed");
  if (input.expectedMembershipId && host.membershipId !== input.expectedMembershipId)
    throw new Error("remote-project.host-removed");
  const validateMembership = async () => {
    if (input.expectedMembershipId) {
      const directory = await input.remoteService.readDirectory();
      if (
        !directory.hosts.some(
          (item) => item.id === input.hostId && item.membershipId === input.expectedMembershipId,
        )
      )
        throw new Error("remote-project.host-removed");
    }
    if (input.projectService && input.projectId) {
      const projects = await input.projectService.readProjects({ hostId: input.hostId });
      if (
        !projects.some(
          (project) =>
            project.id === input.projectId &&
            project.hostId === input.hostId &&
            !project.deleted &&
            project.roots.length === 1 &&
            project.roots[0]?.rootPath === input.workspacePath,
        )
      )
        throw new Error("project.not-found");
    }
    assertCurrent();
    return true;
  };
  const existing = input.findSession(input.workspaceIdentity);
  // 已知目标应在首连时绑定 context；先连共享 "/" 再绑定会让旧导航误删仍被新 caller join 的 scope。
  const sessionId =
    existing?.sessionId ??
    (await input.connect(host.target, undefined, {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
    }));
  try {
    // 连接和绑定都会等待远端；只回收本次创建的 attachment，不能取消其他项目复用的连接。
    assertCurrent();
    if (input.expectedMembershipId || input.projectService) {
      // Host 在连接等待中被移除再添加时，原请求不能借新成员的身份提交导航。
      await validateMembership();
      await input.bind(sessionId, input.workspacePath, validateMembership);
    } else if (input.isCurrent) await input.bind(sessionId, input.workspacePath, input.isCurrent);
    else await input.bind(sessionId, input.workspacePath);
    const bound = input.findSession(input.workspaceIdentity);
    if (bound?.sessionId !== sessionId) throw new Error("project.workspace-identity-mismatch");
    return sessionId;
  } catch (error) {
    // 连接等待期间其他导航/恢复可 join 并提升同一 scope；旧查询的缺席不再授予整 session 回收权。
    if (!existing && input.findSession(input.workspaceIdentity, sessionId)?.sessionId !== sessionId)
      await input.cancel(sessionId);
    throw error;
  }
}
