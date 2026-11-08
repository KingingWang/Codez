import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transpileOfficialPlugin } from "../src/official-plugin-transpile.js";

const BASE = {
  bakedPluginRoot: "/materialized/plugins/demo/1.0.0",
  nativeDataRoot: "/codex-home/plugins/data/demo-codez-plugins-official",
  zcodeBaseUrl: "https://zcode.z.ai",
  expectedName: "demo",
  expectedVersion: "1.0.0",
};

async function hookFixture(hooks: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "official-plugin-hooks-"));
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await mkdir(join(dir, "skills/demo"), { recursive: true });
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(
    join(dir, ".claude-plugin/plugin.json"),
    `${JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
  await writeFile(join(dir, "hooks/hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, "utf8");
  return dir;
}

async function adaptedHooks(dir: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(dir, "hooks/hooks.json"), "utf8"));
  return parsed.hooks as Record<string, unknown>;
}

function commands(hooks: Record<string, unknown>, event = "SessionStart"): string[] {
  const groups = (hooks[event] ?? []) as Array<{
    hooks: Array<{ command?: unknown }>;
  }>;
  return groups.flatMap((group) => group.hooks.map((handler) => String(handler.command)));
}

test("process hook 项目参数转换成安全相对路径且不烘焙 workspace cwd", async () => {
  const posix = await hookFixture({
    SessionStart: [
      {
        hooks: [
          {
            type: "process",
            command: "node",
            args: ["${ZCODE_PROJECT_DIR}", "${CLAUDE_PROJECT_DIR}/workspace/file"],
          },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: posix });
    assert.equal(result.installation, "AVAILABLE");
    assert.deepEqual(commands(await adaptedHooks(posix)), ['node . "./workspace/file"']);
    const hooksJson = JSON.stringify(await adaptedHooks(posix));
    assert.doesNotMatch(hooksJson, /materialized\/workspace|ZCODE_PROJECT_DIR/);
  } finally {
    await rm(posix, { recursive: true, force: true });
  }

  const windows = await hookFixture({
    SessionStart: [
      {
        hooks: [
          {
            type: "process",
            command: "node",
            args: ["${CLAUDE_PROJECT_DIR}\\data\\file"],
          },
        ],
      },
    ],
  });
  try {
    await transpileOfficialPlugin({ ...BASE, pluginDir: windows });
    assert.deepEqual(commands(await adaptedHooks(windows)), ['node ".\\\\data\\\\file"']);
  } finally {
    await rm(windows, { recursive: true, force: true });
  }
});

test("process hook 普通参数保留完整 shell quoting", async () => {
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [
          {
            type: "process",
            command: "my runner",
            args: ["argument with space", "semi;colon", "`backtick`", '"quoted"', "safe"],
          },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "AVAILABLE");
    assert.deepEqual(commands(await adaptedHooks(dir)), [
      '"my runner" "argument with space" "semi;colon" "\\`backtick\\`" "\\"quoted\\"" safe',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command string 独立项目参数支持安全相对前缀，其他拼接与未知变量丢弃", async () => {
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [
          { type: "command", command: "run ${ZCODE_PROJECT_DIR}" },
          { type: "command", command: "run ${CLAUDE_PROJECT_DIR}/safe" },
          { type: "command", command: "prefix-${ZCODE_PROJECT_DIR} suffix" },
          { type: "command", command: "run ${ZCODE_PROJECT_DIR}/safe/suffix" },
          {
            type: "command",
            command: "run ${CLAUDE_PLUGIN_DATA}-${ZCODE_PROJECT_DIR}",
          },
          { type: "command", command: "run ${UNKNOWN_VARIABLE}" },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.deepEqual(commands(hooks), ["run .", "run ./safe", "run ./safe/suffix"]);
    assert.ok(result.warnings.some((warning) => /project directory.*argument/i.test(warning)));
    assert.ok(result.warnings.some((warning) => warning.includes("UNKNOWN_VARIABLE")));
    assert.doesNotMatch(JSON.stringify(hooks), /CLAUDE_PROJECT_DIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook 项目参数拼接 URL、默认值或非参数使用会丢弃 handler 并警告", async () => {
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [
          { type: "command", command: "run https://${ZCODE_PROJECT_DIR}/x" },
          { type: "command", command: "run ${ZCODE_PROJECT_DIR:-default}" },
          { type: "command", command: "echo project=${ZCODE_PROJECT_DIR}" },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.deepEqual(commands(hooks), []);
    assert.ok(result.warnings.some((warning) => /project directory.*argument/i.test(warning)));
    assert.doesNotMatch(JSON.stringify(hooks), /ZCODE_PROJECT_DIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未引用 shell operators 或替换会丢弃 command hook 并警告", async () => {
  const commandsToReject = [
    "echo $(cat ${ZCODE_PROJECT_DIR}/secret)",
    "cat <${ZCODE_PROJECT_DIR}/input",
    "cat >${ZCODE_PROJECT_DIR}/output",
    "echo x & cat ${ZCODE_PROJECT_DIR}/secret",
    "echo x ; cat ${ZCODE_PROJECT_DIR}/secret",
    "echo x | cat ${ZCODE_PROJECT_DIR}/secret",
    "echo `cat ${ZCODE_PROJECT_DIR}/secret`",
    'echo "$(cat ${ZCODE_PROJECT_DIR}/secret)"',
    'echo "`cat ${ZCODE_PROJECT_DIR}/secret`"',
  ];
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: commandsToReject.map((command) => ({ type: "command", command })),
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.deepEqual(commands(hooks), []);
    assert.ok(result.warnings.some((warning) => /shell syntax/i.test(warning)));
    assert.doesNotMatch(JSON.stringify(hooks), /ZCODE_PROJECT_DIR|CLAUDE_PROJECT_DIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("process hook 参数中的 command substitution 会被拒绝", async () => {
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [
          {
            type: "process",
            command: "node",
            args: ["$(cat ${ZCODE_PROJECT_DIR}/secret)"],
          },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.deepEqual(commands(hooks), []);
    assert.ok(result.warnings.some((warning) => /shell syntax/i.test(warning)));
    assert.doesNotMatch(JSON.stringify(hooks), /ZCODE_PROJECT_DIR|CLAUDE_PROJECT_DIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("process hook 引号内的 command substitution 同样会被拒绝", async () => {
  for (const argument of ['"$(id)"', "'$(id)'"]) {
    const dir = await hookFixture({
      SessionStart: [
        {
          hooks: [{ type: "process", command: "node", args: [argument] }],
        },
      ],
    });
    try {
      const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
      assert.deepEqual(commands(await adaptedHooks(dir)), []);
      assert.ok(result.warnings.some((warning) => /shell syntax/i.test(warning)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("process hook 独立参数中的其他 shell 字符按字面量安全引用", async () => {
  const literalArguments = [
    "<input",
    ">output",
    "& cat secret",
    "; cat secret",
    "| cat secret",
    "`cat secret`",
  ];
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [{ type: "process", command: "node", args: literalArguments }],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.equal(commands(hooks).length, 1);
    assert.equal(
      result.warnings.some((warning) => /shell syntax/i.test(warning)),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ZCODE_PLUGIN_DATA 映射到 CLAUDE_PLUGIN_DATA，既有 PLUGIN_DATA 保持原样", async () => {
  const dir = await hookFixture({
    SessionStart: [
      {
        hooks: [
          { type: "command", command: "zcode ${ZCODE_PLUGIN_DATA}/state" },
          { type: "command", command: "legacy ${PLUGIN_DATA}/state" },
          { type: "command", command: "claude ${CLAUDE_PLUGIN_DATA}/state" },
        ],
      },
    ],
  });
  try {
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    const hooks = await adaptedHooks(dir);
    assert.deepEqual(commands(hooks), [
      'zcode "${CLAUDE_PLUGIN_DATA}/state"',
      'legacy "${PLUGIN_DATA}/state"',
      'claude "${CLAUDE_PLUGIN_DATA}/state"',
    ]);
    assert.equal(JSON.stringify(hooks).match(/CLAUDE_PLUGIN_DATA/g)?.length, 2);
    assert.doesNotMatch(JSON.stringify(hooks), /ZCODE_PLUGIN_DATA/);
    assert.equal(
      result.warnings.some((warning) => warning.includes("PLUGIN_DATA")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
