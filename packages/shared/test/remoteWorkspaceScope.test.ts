import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceScope,
  isRemoteWorkspaceIdentity,
  LOCAL_WORKSPACE_SCOPE,
  parseRemoteWorkspaceIdentity,
  parseRemoteWorkspaceScope,
} from "../src/remote-workspace-identity.js";

// 阶段一项目分组作用域：远端 authority 稳定、不含路径、与 identity 构造共享规范化。
// 约束来源：specs/git-worktree-projects.md 的「身份与分组」一节。

test("buildRemoteWorkspaceScope 与 identity 共享 authority 规范化", () => {
  const ssh = { kind: "ssh", host: "ExAmPLE.com ", port: 22, username: " dev " } as const;
  assert.equal(buildRemoteWorkspaceScope(ssh), "remote:ssh:example.com:22:dev");
  // identity = scope + ":" + 归一路径，拼装关系稳定且格式不变。
  assert.equal(
    buildRemoteWorkspaceIdentity("/home/dev/repo/", ssh),
    "remote:ssh:example.com:22:dev:/home/dev/repo",
  );

  const sshDefaultPort = { kind: "ssh", host: "example.com", username: "dev" } as const;
  assert.equal(buildRemoteWorkspaceScope(sshDefaultPort), "remote:ssh:example.com:22:dev");

  const wslNoUser = { kind: "wsl", distro: "Ubuntu" } as const;
  assert.equal(buildRemoteWorkspaceScope(wslNoUser), "remote:wsl:Ubuntu");

  const wslUser = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
  assert.equal(buildRemoteWorkspaceScope(wslUser), "remote:wsl:Ubuntu:dev");

  const docker = { kind: "docker", container: "dev-box" } as const;
  assert.equal(buildRemoteWorkspaceScope(docker), "remote:docker:dev-box");
});

test("parseRemoteWorkspaceScope 与构造互为往返", () => {
  const targets = [
    { kind: "ssh", host: "example.com", port: 2222, username: "dev" },
    { kind: "wsl", distro: "Ubuntu" },
    { kind: "wsl", distro: "Ubuntu", user: "dev" },
    { kind: "docker", container: "dev-box" },
  ] as const;
  for (const target of targets) {
    const scope = buildRemoteWorkspaceScope(target);
    const identity = buildRemoteWorkspaceIdentity("/repo/tree-a", target);
    assert.equal(parseRemoteWorkspaceScope(identity), scope);
  }
});

test("同一远端的不同工作树作用域相同，不同远端作用域不同", () => {
  const target = { kind: "ssh", host: "example.com", username: "dev" } as const;
  const treeA = buildRemoteWorkspaceIdentity("/repo", target);
  const treeB = buildRemoteWorkspaceIdentity("/repo-worktrees/feature", target);
  assert.equal(parseRemoteWorkspaceScope(treeA), parseRemoteWorkspaceScope(treeB));

  const other = { kind: "ssh", host: "other.example.com", username: "dev" } as const;
  const foreign = buildRemoteWorkspaceIdentity("/repo", other);
  assert.notEqual(parseRemoteWorkspaceScope(treeA), parseRemoteWorkspaceScope(foreign));
});

test("parseRemoteWorkspaceScope 对非法输入返回 null，调用方据此放弃合组", () => {
  assert.equal(parseRemoteWorkspaceScope("/plain/local/path"), null);
  assert.equal(parseRemoteWorkspaceScope("remote:"), null);
  assert.equal(parseRemoteWorkspaceScope("remote:unknown:x:/p"), null);
  assert.equal(parseRemoteWorkspaceScope("remote:ssh:host:/missing-user-segments"), null);
});

test("parseRemoteWorkspaceIdentity 既有行为不变", () => {
  const identity = "remote:ssh:example.com:22:dev:/home/dev/repo";
  assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
    kind: "ssh",
    workspacePath: "/home/dev/repo",
  });
  assert.equal(isRemoteWorkspaceIdentity(identity), true);
  assert.equal(isRemoteWorkspaceIdentity("/local/path"), false);
});

test("本地作用域常量不与任何远端作用域冲突", () => {
  assert.equal(LOCAL_WORKSPACE_SCOPE, "local");
  assert.equal(LOCAL_WORKSPACE_SCOPE.startsWith("remote:"), false);
});
