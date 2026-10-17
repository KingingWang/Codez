import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexRpcPort } from "../src/contract.js";
import { handleControlRequest } from "../src/control-plane.js";
import { writeCodexHooksConfig } from "../src/control-hooks.js";
import { scopedNativeRequest } from "../src/request-scope.js";

test("scopedNativeRequest scopes hooks/list to the workspace cwd", async () => {
  const rpc: CodexRpcPort = {
    async request() {
      throw new Error("unexpected rpc");
    },
    async respond() {},
    async respondError() {},
  };
  const scoped = await scopedNativeRequest(
    { method: "hooks/list", params: {} },
    rpc,
    "/workspace",
  );
  assert.deepEqual(scoped, {
    method: "hooks/list",
    params: { cwds: ["/workspace"] },
  });
});

test("hooks/configWrite adds, updates, and deletes command hooks in user and project hooks.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-hooks-write-"));
  const cwd = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  await mkdir(cwd, { recursive: true });
  await mkdir(codexHome, { recursive: true });

  const rpc: CodexRpcPort = {
    async request<T>(method: string): Promise<T> {
      if (method === "config/read") {
        return { layers: [] } as T;
      }
      throw new Error(`unexpected rpc: ${method}`);
    },
    async respond() {},
    async respondError() {},
  };
  const context = { rpc, cwd };
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  const env = { ...process.env, CODEX_HOME: codexHome };

  const addResult = await writeCodexHooksConfig(
    context,
    {
      workspace,
      scope: "project",
      action: "add",
      hook: {
        event: "PreToolUse",
        command: "./scripts/check.sh",
        matcher: "Bash",
        timeoutSec: 45,
        statusMessage: "checking bash",
      },
    },
    env,
  );
  assert.equal(addResult.hooksFilePath, join(cwd, ".codex", "hooks.json"));
  const afterAdd = JSON.parse(await readFile(addResult.hooksFilePath, "utf8"));
  assert.deepEqual(afterAdd, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "./scripts/check.sh",
              timeout: 45,
              statusMessage: "checking bash",
            },
          ],
        },
      ],
    },
  });

  await writeCodexHooksConfig(
    context,
    {
      workspace,
      scope: "project",
      action: "update",
      target: {
        event: "PreToolUse",
        command: "./scripts/check.sh",
        matcher: "Bash",
      },
      hook: {
        event: "PostToolUse",
        command: "./scripts/post-check.sh",
        async: true,
      },
    },
    env,
  );
  const afterUpdate = JSON.parse(await readFile(addResult.hooksFilePath, "utf8"));
  assert.deepEqual(afterUpdate, {
    hooks: {
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "./scripts/post-check.sh",
              async: true,
            },
          ],
        },
      ],
    },
  });

  await writeCodexHooksConfig(
    context,
    {
      workspace,
      scope: "project",
      action: "delete",
      target: {
        event: "PostToolUse",
        command: "./scripts/post-check.sh",
      },
    },
    env,
  );
  const afterDelete = JSON.parse(await readFile(addResult.hooksFilePath, "utf8"));
  assert.deepEqual(afterDelete, { hooks: {} });

  // Control-plane dispatch check
  const dispatched = await handleControlRequest(
    "hooks/configWrite",
    {
      workspace,
      scope: "project",
      action: "add",
      hook: {
        event: "SessionStart",
        command: "echo start",
      },
    },
    context,
  );
  assert.deepEqual(dispatched, { hooksFilePath: join(cwd, ".codex", "hooks.json") });
});
