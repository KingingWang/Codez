import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceScope,
  parseRemoteWorkspaceScope,
  type RemoteTarget,
} from "@codez/shared";
import { buildRemoteWorkspaceIdentity } from "./remoteWorkspaceHistory.js";

// 评审 M2 的回归锁：UI 存量 identity 构造器与 shared 作用域构造必须同源——
// 同一 target，UI 构造出的 identity 解析回的作用域恒等于直接构造的作用域。
// 覆盖 ssh 默认/自定义端口、wsl 无/有 user、空 distro、docker。

const targets: RemoteTarget[] = [
  { kind: "ssh", host: "Example.com", username: "dev" },
  { kind: "ssh", host: "example.com", port: 2222, username: "dev ops".trim() },
  { kind: "wsl" },
  { kind: "wsl", distro: "Ubuntu" },
  { kind: "wsl", distro: "Ubuntu", user: "dev" },
  { kind: "wsl", distro: "  ", user: "dev" },
  { kind: "docker", container: "dev-box" },
];

test("UI identity 与 shared 作用域同源（交叉断言）", () => {
  for (const target of targets) {
    const identity = buildRemoteWorkspaceIdentity("/repo/tree-a", target);
    const scope = buildRemoteWorkspaceScope(target);
    assert.equal(
      parseRemoteWorkspaceScope(identity),
      scope,
      `target=${JSON.stringify(target)} 的 identity 解析作用域应与直接构造一致`,
    );
  }
});

test("同远端不同工作树经 UI identity 合组；不同远端不合组", () => {
  const target: RemoteTarget = { kind: "ssh", host: "example.com", username: "dev" };
  const treeA = buildRemoteWorkspaceIdentity("/repo", target);
  const treeB = buildRemoteWorkspaceIdentity("/repo-wt/feature", target);
  assert.equal(parseRemoteWorkspaceScope(treeA), parseRemoteWorkspaceScope(treeB));

  const other: RemoteTarget = { kind: "ssh", host: "other.example.com", username: "dev" };
  assert.notEqual(
    parseRemoteWorkspaceScope(buildRemoteWorkspaceIdentity("/repo", other)),
    parseRemoteWorkspaceScope(treeA),
  );
});
