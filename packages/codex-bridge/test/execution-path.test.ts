import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalExecutionPath,
  normalizeExecutionSpelling,
  sameExecutionPath,
} from "../src/execution-path.js";

test("windows verbatim spellings normalize to the same path", () => {
  assert.equal(normalizeExecutionSpelling("\\\\?\\C:\\work"), "C:\\work");
  assert.equal(normalizeExecutionSpelling("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
  assert.equal(normalizeExecutionSpelling("/work"), "/work");
});

test("alias and physical spellings of one directory compare equal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-execution-path-"));
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  const foreign = join(root, "foreign");
  await mkdir(physical);
  await mkdir(foreign);
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  assert.equal(await canonicalExecutionPath(alias), await realpath(physical));
  assert.equal(await sameExecutionPath(alias, physical), true);
  assert.equal(await sameExecutionPath(physical, alias), true);
  assert.equal(await sameExecutionPath(alias, alias), true);
  // 归属边界不能被放宽：另一个真实目录、相对路径和非字符串都必须判否。
  assert.equal(await sameExecutionPath(foreign, physical), false);
  assert.equal(await sameExecutionPath(join(alias, "..", "foreign"), physical), false);
  assert.equal(await sameExecutionPath("physical", physical), false);
  assert.equal(await sameExecutionPath(undefined, physical), false);
});

test("missing directories fall back to their spelling instead of rejecting", async () => {
  // 历史会话可能记录已被删除的目录；解析失败不能抛错，也不能与别的目录相等。
  assert.equal(await canonicalExecutionPath("/does/not/exist"), "/does/not/exist");
  assert.equal(await sameExecutionPath("/does/not/exist", "/does/not/exist"), true);
  assert.equal(await sameExecutionPath("/does/not/exist", "/also/missing"), false);
});
