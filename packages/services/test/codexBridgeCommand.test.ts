import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ZCODE_WORKSPACE_IDENTITY_ENV } from "@zcode/shared";
import {
  resolveCodexBridgeCommand,
  usesCodexBridgeRuntime,
} from "../src/zcode-agent/codexBridgeCommand.js";
import {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "../src/zcode-agent/zcodeAgentProcessManager.js";

const context = {
  workspacePath: "/workspace with spaces/项目",
  workspaceKey: "remote-identity",
  presentationSurface: "desktop" as const,
};

test("deployed bridge env wins over packaged/dev discovery even without desktop presentation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-codex-deployed-"));
  const previous = { ...process.env };
  const bridge = join(cwd, "remote root", "codex", "bridge.cjs");
  try {
    await mkdir(dirname(bridge), { recursive: true });
    await writeFile(bridge, "");
    await writeFile(join(dirname(bridge), "codex"), "");
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    delete process.env.ZCODE_CODEX_COMMAND;
    delete process.env.ZCODE_DESKTOP_RUNTIME;
    process.env.ZCODE_CODEX_BRIDGE_PATH = bridge;
    const command = resolveDefaultZCodeAgentCommand({ ...context, presentationSurface: undefined });
    assert.deepEqual(command?.args, [bridge]);
    assert.equal(command?.env?.ZCODE_CODEX_COMMAND, join(dirname(bridge), "codex"));
    assert.equal(command?.supportsStorageStartup, undefined);
    assert.throws(
      () =>
        resolveCodexBridgeCommand(context, {
          env: { ZCODE_CODEX_BRIDGE_PATH: "~/remote/bridge.cjs" },
        }),
      /absolute bridge path/,
    );
    assert.throws(
      () =>
        resolveCodexBridgeCommand(context, {
          env: { ZCODE_CODEX_BRIDGE_PATH: join(cwd, "missing.cjs") },
        }),
      /absolute bridge path/,
    );
    process.env.ZCODE_AGENT_SERVER_COMMAND = "/explicit/legacy";
    process.env.ZCODE_AGENT_SERVER_ARGS_JSON = '["stdio"]';
    assert.equal(resolveDefaultZCodeAgentCommand(context)?.command, "/explicit/legacy");
  } finally {
    process.env = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Codex runtime selection is explicit remotely and preserves custom/legacy overrides", () => {
  const options = { desktopDefault: false, customCommandResolver: false };
  assert.equal(usesCodexBridgeRuntime(options, {}), false);
  assert.equal(
    usesCodexBridgeRuntime(options, { ZCODE_CODEX_BRIDGE_PATH: "/remote/bridge.cjs" }),
    true,
  );
  assert.equal(usesCodexBridgeRuntime(options, { ZCODE_DESKTOP_RUNTIME: "codex" }), true);
  assert.equal(
    usesCodexBridgeRuntime(
      { ...options, desktopDefault: true },
      { ZCODE_DESKTOP_RUNTIME: "legacy" },
    ),
    false,
  );
  assert.equal(
    usesCodexBridgeRuntime(
      { ...options, customCommandResolver: true },
      { ZCODE_DESKTOP_RUNTIME: "codex" },
    ),
    false,
  );
  assert.equal(
    usesCodexBridgeRuntime(options, {
      ZCODE_DESKTOP_RUNTIME: "codex",
      ZCODE_AGENT_SERVER_COMMAND: "/legacy",
    }),
    false,
  );
});

test("development launches the built bridge with Node and a native executable env override", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-codex-command-"));
  const bridge = join(cwd, "packages/codex-bridge/dist/bridge.cjs");
  try {
    await mkdir(dirname(bridge), { recursive: true });
    await writeFile(bridge, "");
    const command = resolveCodexBridgeCommand(context, {
      cwd,
      execPath: "/node",
      env: { ZCODE_CODEX_COMMAND: " /native codex/二进制 " },
    });
    assert.deepEqual(command, {
      command: "/node",
      args: [bridge],
      cwd: context.workspacePath,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ZCODE_CODEX_COMMAND: "/native codex/二进制",
        [ZCODE_WORKSPACE_IDENTITY_ENV]: context.workspaceKey,
      },
    });
    assert.equal(command.supportsStorageStartup, undefined);
    assert.equal(command.storagePreparationEntry, undefined);
    assert.equal(
      resolveCodexBridgeCommand(
        { ...context, workspaceKey: context.workspacePath },
        { cwd, env: {} },
      ).env?.[ZCODE_WORKSPACE_IDENTITY_ENV],
      context.workspacePath,
      "local path-fallback identity survives a canonicalized process cwd",
    );
    assert.equal(
      resolveCodexBridgeCommand(context, { cwd, env: {} }).env?.ZCODE_CODEX_COMMAND,
      "codex",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const platform of ["linux", "darwin", "win32"] as const) {
  test(`packaged ${platform} selects resources/codex without legacy arguments`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-codex-packaged-"));
    const resourcesPath = join(cwd, "resources");
    const bridge = join(resourcesPath, "codex/bridge.cjs");
    try {
      await mkdir(dirname(bridge), { recursive: true });
      await writeFile(bridge, "");
      const native = join(resourcesPath, "codex", platform === "win32" ? "codex.exe" : "codex");
      assert.throws(
        () => resolveCodexBridgeCommand(context, { cwd, resourcesPath, platform, env: {} }),
        /Codex executable missing/,
      );
      await writeFile(native, "");
      const command = resolveCodexBridgeCommand(context, { cwd, resourcesPath, platform, env: {} });
      assert.deepEqual(command.args, [bridge]);
      assert.equal(command.env?.ZCODE_CODEX_COMMAND, native);
      assert.equal(command.supportsStorageStartup, undefined);
      assert.equal(command.storagePreparationEntry, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("missing bridge gives an actionable error instead of falling back to the legacy engine", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-codex-missing-"));
  try {
    assert.throws(() => resolveCodexBridgeCommand(context, { cwd, env: {} }), /build-codex-bridge/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit legacy command and argument override retain precedence", () => {
  const previous = { ...process.env };
  try {
    process.env.ZCODE_AGENT_SERVER_COMMAND = "/custom/agent";
    process.env.ZCODE_AGENT_SERVER_ARGS_JSON = '["custom-stdio"]';
    process.env.ZCODE_AGENT_SERVER_CWD = "/custom/cwd";
    assert.deepEqual(resolveDefaultZCodeAgentCommand(context), {
      command: "/custom/agent",
      args: ["custom-stdio", "--surface", "desktop"],
      cwd: "/custom/cwd",
    });
  } finally {
    process.env = previous;
  }
});

test("process manager launches and reuses a bridge without waiting for legacy storage startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-codex-process-"));
  const bridge = join(cwd, "packages/codex-bridge/dist/bridge.cjs");
  const native = join(cwd, "native codex 二进制");
  const manager = new ZCodeAgentProcessManager({
    presentationSurface: "desktop",
    requestTimeoutMs: 2_000,
    commandResolver: (target) =>
      resolveCodexBridgeCommand(target, {
        cwd,
        env: { ZCODE_CODEX_COMMAND: native },
      }),
  });
  try {
    await mkdir(dirname(bridge), { recursive: true });
    await writeFile(
      bridge,
      `
      const { createInterface } = require("node:readline");
      createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: request.id, result: {
          argv: process.argv.slice(2), native: process.env.ZCODE_CODEX_COMMAND,
          workspaceIdentity: process.env[${JSON.stringify(ZCODE_WORKSPACE_IDENTITY_ENV)}],
          cwd: process.cwd(), request: request.params,
        } }) + "\\n");
      });
    `,
    );
    const workspace = { workspacePath: cwd, workspaceIdentity: "remote-process-example" };
    const [first, second] = await Promise.all([
      manager.getClient(workspace),
      manager.getClient(workspace),
    ]);
    assert.equal(first, second);
    assert.equal(first.storageStartup.isWaiting, false);
    const request = { method: "account/read" };
    assert.deepEqual(await first.request("codex/request", request), {
      argv: [],
      native,
      workspaceIdentity: workspace.workspaceIdentity,
      cwd,
      request,
    });
    assert.equal(manager.listManagedProcesses().length, 1);
  } finally {
    await manager.disposeAllAndWait();
    await rm(cwd, { recursive: true, force: true });
  }
});
