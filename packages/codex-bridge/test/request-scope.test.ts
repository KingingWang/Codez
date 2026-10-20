import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scopeWorkspaceParams, scopedNativeRequest } from "../src/request-scope.js";
import type { CodexRpcPort } from "../src/contract.js";

test("filesystem aliases preserve Host identity but normalize execution paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-workspace-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "real");
  const alias = join(root, "alias");
  const foreign = join(root, "other");
  await mkdir(directory);
  await mkdir(foreign);
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const cwd = await realpath(directory);
  const params = { workspace: { workspacePath: alias, workspaceKey: alias } };
  assert.deepEqual(await scopeWorkspaceParams(params, cwd, alias), {
    workspace: { workspacePath: cwd, workspaceKey: alias, workspaceIdentity: alias },
  });
  assert.equal(params.workspace.workspacePath, alias, "caller input is not mutated");
  await assert.rejects(
    scopeWorkspaceParams(
      { workspace: { ...params.workspace, workspaceIdentity: "foreign" } },
      cwd,
      alias,
    ),
    /scope mismatch/,
  );
  await assert.rejects(
    scopeWorkspaceParams({ workspace: { workspacePath: foreign } }, cwd, alias),
    /scope mismatch/,
  );
  await assert.rejects(
    scopeWorkspaceParams({ workspace: { workspacePath: join(root, "missing") } }, cwd, alias),
    /scope mismatch/,
  );
  const rpc = {
    request: async () => {
      throw new Error("must not dispatch");
    },
  } as unknown as CodexRpcPort;
  assert.deepEqual(
    await scopedNativeRequest({ method: "config/read", params: { cwd: alias } }, rpc, cwd),
    {
      method: "config/read",
      params: { cwd },
    },
  );
  assert.deepEqual(
    await scopedNativeRequest({ method: "skills/list", params: { cwds: [alias] } }, rpc, cwd),
    {
      method: "skills/list",
      params: { cwds: [cwd] },
    },
  );
  await assert.rejects(
    scopedNativeRequest({ method: "config/read", params: { cwd: foreign } }, rpc, cwd),
    /scope mismatch/,
  );
  await assert.rejects(
    scopedNativeRequest({ method: "skills/list", params: { cwds: [alias, foreign] } }, rpc, cwd),
    /scope mismatch/,
  );
});
