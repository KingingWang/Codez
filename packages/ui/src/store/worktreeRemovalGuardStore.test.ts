import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorktreeRemovalGuardKey,
  isWorktreeRemovalInFlight,
  useWorktreeRemovalGuardStore,
} from "./worktreeRemovalGuardStore.js";

function reset() {
  useWorktreeRemovalGuardStore.setState({ targets: {} });
}

test("删除中守卫：根路径与树下子目录均拦截，兄弟路径与其他 scope 放行（审查 ④）", () => {
  reset();
  const store = useWorktreeRemovalGuardStore.getState();
  store.markDeleting(buildWorktreeRemovalGuardKey("local", "/repo/trees/feat"));

  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feat"), true);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feat/src"), true);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feat/src/deep/dir"), true);
  // 前缀字符串巧合不算子目录：feature 不是 feat 的子目录。
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feature"), false);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees"), false);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo"), false);
  // 同路径但不同 scope（远端与本地路径文本相同）不互相拦截。
  assert.equal(isWorktreeRemovalInFlight("remote:ssh://a", "/repo/trees/feat"), false);
});

test("删除中守卫：unmark 后放行，重复 unmark 与未注册 key 安全", () => {
  reset();
  const store = useWorktreeRemovalGuardStore.getState();
  const key = buildWorktreeRemovalGuardKey("local", "/repo/trees/feat");
  store.unmarkDeleting(key);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feat"), false);

  store.markDeleting(key);
  store.unmarkDeleting(key);
  assert.equal(isWorktreeRemovalInFlight("local", "/repo/trees/feat"), false);
  assert.deepEqual(useWorktreeRemovalGuardStore.getState().targets, {});
  store.unmarkDeleting(key);
  assert.deepEqual(useWorktreeRemovalGuardStore.getState().targets, {});
});
