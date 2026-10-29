import { expect, it, vi } from "vitest";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";

function fixture() {
  const sessions = new Map<string, { sessionId: string }>();
  const identity = "remote:server:s:/same";
  const input = {
    hostId: "remote:server:s",
    workspacePath: "/same",
    workspaceIdentity: identity,
    remoteService: {
      connectHost: vi.fn(async () => ({
        id: "remote:server:s",
        target: { kind: "docker", container: "s" },
      })),
    } as never,
    findSession: (key: string) => sessions.get(key),
    connect: vi.fn(
      async (..._args: Parameters<ProjectSidebarProps["onConnectRemote"]>) => "new-session",
    ),
    bind: vi.fn(async (sessionId: string) => {
      sessions.set(identity, { sessionId });
    }),
    cancel: vi.fn(async () => {}),
  };
  return { sessions, identity, input };
}
it("uses the exact identity and existing physical connection, not another Source's same cwd", async () => {
  const { sessions, input } = fixture();
  sessions.set("remote:server:other:/same", { sessionId: "other" });
  expect(await attachRemoteProjectWorkspace(input)).toBe("new-session");
  expect(input.connect).toHaveBeenCalledOnce();
  expect(input.connect).toHaveBeenCalledWith({ kind: "docker", container: "s" }, undefined, {
    workspacePath: "/same",
    workspaceIdentity: input.workspaceIdentity,
  });
  expect(input.bind).toHaveBeenCalledWith("new-session", "/same");
  expect(input.cancel).not.toHaveBeenCalled();
});
it("reuses the attached workspace and does not cancel it on failure", async () => {
  const { sessions, identity, input } = fixture();
  sessions.set(identity, { sessionId: "existing" });
  input.bind.mockRejectedValueOnce(new Error("bind failed"));
  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow("bind failed");
  expect(input.connect).not.toHaveBeenCalled();
  expect(input.cancel).not.toHaveBeenCalled();
});
it("releases only the new logical attachment when binding fails", async () => {
  const { input } = fixture();
  input.bind.mockRejectedValueOnce(new Error("bind failed"));
  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow("bind failed");
  expect(input.cancel).toHaveBeenCalledWith("new-session");
});

it("does not bind a late connection after navigation is superseded and releases its attachment", async () => {
  const { input } = fixture();
  let current = true;
  input.connect.mockImplementation(async () => {
    current = false;
    return "late";
  });
  await expect(
    attachRemoteProjectWorkspace({ ...input, isCurrent: () => current }),
  ).rejects.toMatchObject({
    message: "project.navigation-cancelled",
    code: "remote-connection-canceled",
  });
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).toHaveBeenCalledWith("late");
});
it("does not create an attachment when the Host response belongs to an old navigation", async () => {
  const { input } = fixture();
  await expect(attachRemoteProjectWorkspace({ ...input, isCurrent: () => false })).rejects.toThrow(
    "project.navigation-cancelled",
  );
  expect(input.connect).not.toHaveBeenCalled();
});

it("does not release a joined attachment promoted while the old navigation was waiting", async () => {
  const { sessions, identity, input } = fixture();
  const gate = Promise.withResolvers<string>();
  input.connect.mockImplementation(() => gate.promise);
  let current = true;
  const old = attachRemoteProjectWorkspace({ ...input, isCurrent: () => current });
  const rejection = expect(old).rejects.toMatchObject({ code: "remote-connection-canceled" });
  await vi.waitFor(() => expect(input.connect).toHaveBeenCalled());
  current = false;
  sessions.set(identity, { sessionId: "joined" });
  gate.resolve("joined");
  await rejection;
  expect(input.cancel).not.toHaveBeenCalled();
  await expect(attachRemoteProjectWorkspace(input)).resolves.toBe("joined");
});

it("keeps a context-connected shared session before the newer caller binds its project", async () => {
  const { sessions, identity, input } = fixture();
  const ready = Promise.withResolvers<string>();
  let current = true;
  input.connect.mockImplementation((_target, _requestId, context) => {
    expect(context).toEqual({ workspacePath: "/same", workspaceIdentity: identity });
    return ready.promise;
  });
  const stale = attachRemoteProjectWorkspace({ ...input, isCurrent: () => current });
  const rejected = expect(stale).rejects.toMatchObject({ code: "remote-connection-canceled" });
  const newer = attachRemoteProjectWorkspace(input);
  await vi.waitFor(() => expect(input.connect).toHaveBeenCalledTimes(2));
  current = false;
  // 与真实 connect ready 合同一致：首挂 ACK 前注册 context 的目标身份，项目 bind 尚未执行。
  sessions.set(identity, { sessionId: "shared-before-bind" });
  ready.resolve("shared-before-bind");
  await rejected;
  await expect(newer).resolves.toBe("shared-before-bind");
  expect(input.cancel).not.toHaveBeenCalled();
  expect(input.bind).toHaveBeenCalledOnce();
});

it("does not bind a replaced Host membership after attachment preparation", async () => {
  const { input } = fixture();
  const host = {
    id: input.hostId,
    membershipId: "original",
    target: { kind: "docker" as const, container: "s" },
  };
  const remoteService = {
    connectHost: vi.fn(async () => host),
    readDirectory: vi.fn(async () => ({
      hosts: [{ ...host, membershipId: "replacement" }],
      entries: [],
    })),
  };
  await expect(
    attachRemoteProjectWorkspace({
      ...input,
      remoteService: remoteService as never,
      expectedMembershipId: "original",
    }),
  ).rejects.toThrow("remote-project.host-removed");
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).toHaveBeenCalledWith("new-session");
});

it("rejects a removed project at the navigation barrier and preserves a shared attachment", async () => {
  const { input, sessions, identity } = fixture();
  sessions.set(identity, { sessionId: "shared" });
  const projectService = { readProjects: vi.fn(async () => []) };
  await expect(
    attachRemoteProjectWorkspace({ ...input, projectId: "removed", projectService }),
  ).rejects.toThrow("project.not-found");
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).not.toHaveBeenCalled();
});
