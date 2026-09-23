import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as s from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import { handleAgentRequest, resolveAgentRoleDirs } from "../src/control-agents.js";
import { handleControlRequest, supportsControlMethod } from "../src/control-plane.js";

const rpc: CodexRpcPort = {
  async request() {
    throw new Error("agents/* never reaches the native Codex RPC");
  },
  async respond() {},
  async respondError() {},
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codez-agents-"));
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "workspace");
  await mkdir(join(codexHome, "agents"), { recursive: true });
  await mkdir(join(cwd, ".codex", "agents"), { recursive: true });
  return {
    root,
    codexHome,
    cwd,
    userDir: join(codexHome, "agents"),
    projectDir: join(cwd, ".codex", "agents"),
    env: { CODEX_HOME: codexHome },
    context: { rpc, cwd },
    workspace: { workspacePath: cwd, workspaceKey: cwd },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const write = (f: Fixture, params: Record<string, unknown>) =>
  handleAgentRequest("agents/write", { workspace: f.workspace, ...params }, f.context, f.env);

const list = async (f: Fixture) =>
  s.codezAgentsListResultSchema.parse(
    await handleAgentRequest("agents/list", { workspace: f.workspace }, f.context, f.env),
  );

async function rejects(promise: Promise<unknown>, reason: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error && typeof error === "object" && "code" in error, "JSON-RPC error expected");
    assert.match(String((error as { message?: unknown }).message), reason);
    return true;
  });
}

test("agents methods register on the control plane without touching the native allowlist", () => {
  for (const method of ["agents/list", "agents/write", "agents/delete"])
    assert.equal(supportsControlMethod(method), true);
  // 原生白名单不得包含 agents/*：codex app-server 没有 agents RPC。
  for (const method of ["agents/list", "agents/write", "agents/delete"])
    assert.equal(s.codexRequestMethodSchema.safeParse(method).success, false);
});

test("resolveAgentRoleDirs honors CODEX_HOME and falls back to ~/.codex", () => {
  const dirs = resolveAgentRoleDirs("/work", { CODEX_HOME: "/custom/home" });
  assert.equal(dirs.userDir, join("/custom/home", "agents"));
  assert.equal(dirs.projectDir, join("/work", ".codex", "agents"));
  const fallback = resolveAgentRoleDirs("/work", {});
  assert.match(fallback.userDir, /\.codex[/\\]agents$/);
});

test("list reads both scopes, tolerates missing dirs, and keeps malformed files as diagnostics", async () => {
  const f = await fixture();
  await writeFile(
    join(f.userDir, "researcher.toml"),
    [
      'name = "researcher"',
      'description = "Reads code and reports"',
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "high"',
      'developer_instructions = "You research."',
      'nickname_candidates = ["scout", "deep-dive"]',
      "",
    ].join("\n"),
  );
  await writeFile(join(f.projectDir, "executor.toml"), 'developer_instructions = "You execute."\n');
  await writeFile(join(f.projectDir, "broken.toml"), "not = [valid");
  await writeFile(join(f.projectDir, "no-instructions.toml"), 'name = "lazy"\n');

  const result = await list(f);
  const researcher = result.roles.find((role) => role.name === "researcher");
  assert.equal(researcher?.scope, "user");
  assert.equal(researcher?.description, "Reads code and reports");
  assert.equal(researcher?.model, "gpt-6-astra");
  assert.equal(researcher?.modelReasoningEffort, "high");
  assert.equal(researcher?.developerInstructions, "You research.");
  assert.deepEqual(researcher?.nicknameCandidates, ["scout", "deep-dive"]);
  assert.equal(researcher?.fileName, "researcher.toml");
  // 未声明 name 时回退文件名主干，与 Codex 加载语义一致。
  const executor = result.roles.find((role) => role.name === "executor");
  assert.equal(executor?.scope, "project");
  const codes = result.diagnostics.map((entry) => entry.code);
  assert.ok(codes.includes("parse_error"), "broken TOML is a diagnostic, not a failure");
  assert.ok(codes.includes("validation_warning"), "missing developer_instructions is flagged");

  // 目录缺失 = 空列表，不是错误。
  const empty = await mkdtemp(join(tmpdir(), "codez-agents-empty-"));
  const emptyResult = s.codezAgentsListResultSchema.parse(
    await handleAgentRequest(
      "agents/list",
      { workspace: { workspacePath: empty, workspaceKey: empty } },
      { rpc, cwd: empty },
      { CODEX_HOME: join(empty, "no-such-home") },
    ),
  );
  assert.deepEqual(emptyResult.roles, []);
});

test("create derives <name>.toml, validates fields, and refuses duplicates", async () => {
  const f = await fixture();
  const role = {
    name: "planner",
    description: "  Plans work  ",
    model: " ",
    developerInstructions: "You plan.",
    nicknameCandidates: ["p1"],
  };
  const created = s.codezAgentsWriteResultSchema.parse(await write(f, { scope: "user", role }));
  assert.equal(created.role.name, "planner");
  assert.equal(created.role.description, "Plans work");
  // model 提交空白 = 不写该 key。
  assert.equal(created.role.model, undefined);
  const contents = await readFile(join(f.userDir, "planner.toml"), "utf8");
  assert.match(contents, /name = "planner"/);
  assert.match(contents, /developer_instructions = "You plan\."/);
  assert.doesNotMatch(contents, /^model = /m);

  await rejects(write(f, { scope: "user", role }), /already exists/);
  // 声明同名的另一文件也构成冲突；无关名字不受影响。
  await writeFile(
    join(f.userDir, "alias.toml"),
    'name = "planner"\ndeveloper_instructions = "x"\n',
  );
  await rejects(write(f, { scope: "user", role }), /already exists/);
  s.codezAgentsWriteResultSchema.parse(
    await write(f, { scope: "user", role: { name: "other", developerInstructions: "y" } }),
  );

  for (const bad of [
    { ...role, name: "has.dot" },
    { ...role, name: "has/slash" },
    { ...role, name: "..\\traverse" },
    { ...role, name: "-leading-dash" },
    { ...role, name: "中文名" },
  ]) {
    await rejects(write(f, { scope: "project", role: bad }), /name may only contain/);
  }
  await rejects(
    write(f, { scope: "project", role: { name: "x", developerInstructions: "   " } }),
    /Invalid parameters/,
  );
  await rejects(
    write(f, {
      scope: "project",
      role: { name: "x", description: "   ", developerInstructions: "y" },
    }),
    /description cannot be blank/,
  );
  for (const nicknameCandidates of [[], ["a", "a"], ["ok", " "], ["nön-ascii"]]) {
    await rejects(
      write(f, {
        scope: "project",
        role: { name: "x", developerInstructions: "y", nicknameCandidates },
      }),
      /nicknameCandidates/,
    );
  }
});

test("update preserves unknown TOML keys and requires an existing role", async () => {
  const f = await fixture();
  await writeFile(
    join(f.projectDir, "reviewer.toml"),
    [
      'name = "reviewer"',
      'description = "Reviews"',
      'developer_instructions = "Old instructions."',
      'sandbox_mode = "read-only"',
      'custom_key = "keep me"',
      "",
      "[nested]",
      "value = 42",
      "",
    ].join("\n"),
  );
  const updated = s.codezAgentsWriteResultSchema.parse(
    await write(f, {
      scope: "project",
      originalName: "reviewer",
      role: {
        name: "reviewer",
        developerInstructions: "New instructions.",
        modelReasoningEffort: "medium",
      },
    }),
  );
  assert.equal(updated.role.developerInstructions, "New instructions.");
  // description 缺省 = 移除该 key；unknown keys 全部保留。
  const contents = await readFile(join(f.projectDir, "reviewer.toml"), "utf8");
  assert.match(contents, /developer_instructions = "New instructions\."/);
  assert.match(contents, /model_reasoning_effort = "medium"/);
  assert.doesNotMatch(contents, /description =/);
  assert.match(contents, /sandbox_mode = "read-only"/);
  assert.match(contents, /custom_key = "keep me"/);
  assert.match(contents, /\[nested\]/);
  assert.match(contents, /value = 42/);

  await rejects(
    write(f, {
      scope: "project",
      originalName: "ghost",
      role: { name: "ghost", developerInstructions: "x" },
    }),
    /no agent role named/,
  );
  await rejects(
    write(f, {
      scope: "project",
      originalName: "reviewer",
      role: { name: "renamed", developerInstructions: "x" },
    }),
    /renaming a role is not supported/,
  );
});

test("writes are atomic (no temp residue) and refuse symlink targets", async () => {
  const f = await fixture();
  await write(f, { scope: "user", role: { name: "atomic", developerInstructions: "x" } });
  const entries = await readdir(f.userDir);
  assert.deepEqual(entries, ["atomic.toml"], "no temp files survive a successful write");

  // 符号链接目标：新建派生路径命中符号链接时拒绝写入；已存在的符号链接不可管理
  // （扫描跳过并诊断），链接外文件保持原样。
  const outside = join(f.root, "outside.toml");
  const original = 'name = "linked"\ndeveloper_instructions = "x"\n';
  await writeFile(outside, original);
  await symlink(outside, join(f.userDir, "linked.toml"));
  await rejects(
    write(f, { scope: "user", role: { name: "linked", developerInstructions: "y" } }),
    /symbolic link/,
  );
  const withLink = await list(f);
  assert.ok(withLink.diagnostics.some((entry) => entry.code === "symlink_skipped"));
  assert.equal(
    withLink.roles.find((role) => role.name === "linked"),
    undefined,
  );
  await rejects(
    write(f, {
      scope: "user",
      originalName: "linked",
      role: { name: "linked", developerInstructions: "y" },
    }),
    /no agent role named/,
  );
  await rejects(
    handleAgentRequest(
      "agents/delete",
      { workspace: f.workspace, scope: "user", name: "linked" },
      f.context,
      f.env,
    ),
    /no agent role named/,
  );
  assert.equal(await readFile(outside, "utf8"), original);
  assert.equal((await lstat(join(f.userDir, "linked.toml"))).isSymbolicLink(), true);
});

test("delete is confined to the requested scope and resolves nested effective names", async () => {
  const f = await fixture();
  await write(f, { scope: "user", role: { name: "shared", developerInstructions: "user" } });
  await write(f, { scope: "project", role: { name: "shared", developerInstructions: "proj" } });
  s.codezAgentsDeleteResultSchema.parse(
    await handleAgentRequest(
      "agents/delete",
      { workspace: f.workspace, scope: "project", name: "shared" },
      f.context,
      f.env,
    ),
  );
  const result = await list(f);
  const remaining = result.roles.filter((role) => role.name === "shared");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.scope, "user");
  await rejects(
    handleAgentRequest(
      "agents/delete",
      { workspace: f.workspace, scope: "project", name: "shared" },
      f.context,
      f.env,
    ),
    /no agent role named/,
  );
  // 嵌套发现的文件可按 effective name 删除，路径解析留在托管目录内。
  await mkdir(join(f.projectDir, "nested"), { recursive: true });
  await writeFile(
    join(f.projectDir, "nested", "deep.toml"),
    'name = "deep"\ndeveloper_instructions = "x"\n',
  );
  assert.equal(
    (await list(f)).roles.find((role) => role.name === "deep")?.fileName,
    "nested/deep.toml",
  );
  await handleAgentRequest(
    "agents/delete",
    { workspace: f.workspace, scope: "project", name: "deep" },
    f.context,
    f.env,
  );
  assert.equal(
    (await list(f)).roles.find((role) => role.name === "deep"),
    undefined,
  );
});

test("workspace mismatch and duplicate effective names fail closed", async () => {
  const f = await fixture();
  await rejects(
    handleAgentRequest(
      "agents/list",
      { workspace: { workspacePath: "/elsewhere", workspaceKey: "/elsewhere" } },
      f.context,
      f.env,
    ),
    /Workspace does not match/,
  );
  await writeFile(join(f.userDir, "a.toml"), 'name = "dup"\ndeveloper_instructions = "x"\n');
  await writeFile(join(f.userDir, "b.toml"), 'name = "dup"\ndeveloper_instructions = "y"\n');
  const result = await list(f);
  assert.ok(result.diagnostics.some((entry) => entry.code === "duplicate_name"));
  await rejects(
    handleAgentRequest(
      "agents/delete",
      { workspace: f.workspace, scope: "user", name: "dup" },
      f.context,
      f.env,
    ),
    /multiple files/,
  );
});

test("control-plane dispatch routes agents/* with validation errors intact", async () => {
  const f = await fixture();
  const result = s.codezAgentsListResultSchema.parse(
    await handleControlRequest("agents/list", { workspace: f.workspace }, f.context),
  );
  // 未注入 env 时 user scope 落到真实 ~/.codex——只验证路由与 schema，不读具体文件。
  assert.ok(Array.isArray(result.roles));
  await rejects(
    handleControlRequest("agents/write", { workspace: f.workspace, scope: "user" }, f.context),
    /Invalid parameters/,
  );
});
