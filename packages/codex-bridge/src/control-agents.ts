import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import * as s from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { ControlError, checkWorkspace, input } from "./control-common.js";
import {
  agentDataInvalid,
  assertNotSymlink,
  canonicalAgentDir,
  confinedAgentTarget,
  findByEffectiveName,
  roleSummary,
  scanRoleDir,
  writeFileAtomic,
  type ParsedRoleFile,
} from "./control-agents-data.js";

// Codex 子智能体（agent roles）文件管理。传输与目录模型见 specs/codex-desktop-subagents.md。
// agents/* 是 bridge 本地 fs 控制面方法族——codex app-server 没有 agents RPC，
// 绝不能进入 codex/request 原生白名单。字段校验镜像 codex-rs/agent-roles/src/agent_role_config.rs。

/** 新建文件时由 name 派生 `<name>.toml` 的严格字符集：无路径分隔符、无点号、无遍历。 */
const ROLE_FILE_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** nickname_candidates 校验与 codex 一致：ASCII 字母数字 + 空格/连字符/下划线。 */
const NICKNAME_CHARSET = /^[A-Za-z0-9 _-]+$/;

export interface AgentRoleDirs {
  userDir: string;
  projectDir: string;
}

/** CODEX_HOME 取自 bridge 进程环境（远程 workspace 即远端进程），缺省 `~/.codex`。 */
export function resolveAgentRoleDirs(cwd: string, env: NodeJS.ProcessEnv): AgentRoleDirs {
  const override = env.CODEX_HOME?.trim();
  const codexHome = override ? override : join(homedir(), ".codex");
  return { userDir: join(codexHome, "agents"), projectDir: join(cwd, ".codex", "agents") };
}

function invalid(method: string, reason: string): never {
  throw new ControlError(-32602, `${method}: ${reason}`, { method, reason });
}

function failure(method: string, reason: string): never {
  throw new ControlError(-32000, `${method}: ${reason}`, { method, reason });
}

function normalizeDescription(method: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  // Codex 规则：description 存在但空白是硬错误；留空请省略字段（= 移除该 key）。
  if (!trimmed) invalid(method, "description cannot be blank; omit it to clear");
  return trimmed;
}

function requireDeveloperInstructions(method: string, value: string): string {
  const trimmed = value.trim();
  // 独立角色文件的 developer_instructions 是系统提示词，Codex 要求必填非空。
  if (!trimmed) invalid(method, "developerInstructions is required and cannot be blank");
  return trimmed;
}

/** model / model_reasoning_effort：可选；trim 后为空 = 清除该 key。 */
function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNicknames(method: string, value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) invalid(method, "nicknameCandidates must contain at least one name");
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const nickname = entry.trim();
    if (!nickname) invalid(method, "nicknameCandidates cannot contain blank names");
    if (seen.has(nickname)) invalid(method, "nicknameCandidates cannot contain duplicates");
    if (!NICKNAME_CHARSET.test(nickname))
      invalid(
        method,
        "nicknameCandidates may only contain ASCII letters, digits, spaces, hyphens and underscores",
      );
    seen.add(nickname);
    normalized.push(nickname);
  }
  return normalized;
}

const MANAGED_KEYS = new Set([
  "name",
  "description",
  "model",
  "model_reasoning_effort",
  "developer_instructions",
  "nickname_candidates",
]);

export async function listAgentRoles(dirs: AgentRoleDirs): Promise<s.CodezAgentsListResult> {
  const diagnostics: s.CodezAgentRoleDiagnostic[] = [];
  const roles: s.CodezAgentRoleSummary[] = [];
  for (const scope of ["user", "project"] as const) {
    const dir = scope === "user" ? dirs.userDir : dirs.projectDir;
    const scan = await scanRoleDir(dir, scope);
    diagnostics.push(...scan.diagnostics);
    for (const file of scan.files) {
      roles.push(roleSummary(scope, file));
      // Codex 加载时会把这些文件跳过并告警；面板列出文件同时如实标注，便于用户修复或删除。
      const description = file.table["description"];
      if (typeof description === "string" && !description.trim())
        diagnostics.push({
          code: "validation_warning",
          message: "description cannot be blank; Codex ignores this role",
          severity: "warning",
          scope,
          fileName: file.segments.join("/"),
        });
      const instructions = file.table["developer_instructions"];
      if (typeof instructions !== "string" || !instructions.trim())
        diagnostics.push({
          code: "validation_warning",
          message:
            "standalone role files must define non-blank developer_instructions; Codex ignores this role",
          severity: "warning",
          scope,
          fileName: file.segments.join("/"),
        });
    }
  }
  roles.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return s.codezAgentsListResultSchema.parse({ roles, diagnostics });
}

export async function writeAgentRole(
  dirs: AgentRoleDirs,
  params: {
    scope: s.CodezAgentRoleScope;
    originalName?: string;
    role: s.CodezAgentRoleWriteInput;
  },
  method: string,
): Promise<s.CodezAgentsWriteResult> {
  const name = params.role.name.trim();
  if (!name) invalid(method, "name is required");
  const description = normalizeDescription(method, params.role.description);
  const developerInstructions = requireDeveloperInstructions(
    method,
    params.role.developerInstructions,
  );
  const model = normalizeOptionalValue(params.role.model);
  const effort = normalizeOptionalValue(params.role.modelReasoningEffort);
  const nicknames = normalizeNicknames(method, params.role.nicknameCandidates);

  const dir = params.scope === "user" ? dirs.userDir : dirs.projectDir;
  // 托管字段先清后写：缺省的可选字段 = 从文件中移除该 key；未知 key 原样保留。
  const mergeManaged = (table: Record<string, unknown>): Record<string, unknown> => {
    const merged = { ...table };
    for (const key of Object.keys(merged)) {
      if (MANAGED_KEYS.has(key)) delete merged[key];
    }
    merged["name"] = name;
    if (description !== undefined) merged["description"] = description;
    if (model !== undefined) merged["model"] = model;
    if (effort !== undefined) merged["model_reasoning_effort"] = effort;
    merged["developer_instructions"] = developerInstructions;
    if (nicknames !== undefined) merged["nickname_candidates"] = nicknames;
    return merged;
  };

  if (params.originalName === undefined) {
    // 新建：name 必须能安全派生 `<name>.toml`，且同 scope 无同 effective name 文件。
    if (!ROLE_FILE_SAFE_NAME.test(name))
      invalid(
        method,
        "name may only contain ASCII letters, digits, spaces, hyphens and underscores, and must start with a letter or digit",
      );
    const root = await canonicalAgentDir(dir, true);
    const scan = await scanRoleDir(root, params.scope);
    if (scan.files.some((file) => file.effectiveName === name))
      invalid(method, `an agent role named "${name}" already exists in this scope`);
    const target = join(root, `${name}.toml`);
    await assertNotSymlink(target, method);
    const table = mergeManaged({});
    await writeFileAtomic(target, stringifyToml(table));
    const file: ParsedRoleFile = {
      segments: [`${name}.toml`],
      absPath: target,
      table,
      effectiveName: name,
    };
    return s.codezAgentsWriteResultSchema.parse({ role: roleSummary(params.scope, file) });
  }

  // 更新：按 originalName 定位既有文件；不支持改名（删除+新建），保证一个名字对应一个文件。
  if (name !== params.originalName)
    invalid(method, "renaming a role is not supported; delete it and create a new one");
  const root = await canonicalAgentDir(dir, false).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") invalid(method, `no agent role named "${name}" in this scope`);
    throw error;
  });
  const scan = await scanRoleDir(root, params.scope);
  const existing = findByEffectiveName(scan, params.originalName, method);
  const target = confinedAgentTarget(root, existing, method);
  await assertNotSymlink(target, method);
  const merged = mergeManaged(existing.table);
  await writeFileAtomic(target, stringifyToml(merged));
  return s.codezAgentsWriteResultSchema.parse({
    role: roleSummary(params.scope, { ...existing, table: merged }),
  });
}

export async function deleteAgentRole(
  dirs: AgentRoleDirs,
  params: { scope: s.CodezAgentRoleScope; name: string },
  method: string,
): Promise<Record<string, never>> {
  const dir = params.scope === "user" ? dirs.userDir : dirs.projectDir;
  const root = await canonicalAgentDir(dir, false).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      agentDataInvalid(method, `no agent role named "${params.name}" in this scope`);
    throw error;
  });
  const scan = await scanRoleDir(root, params.scope);
  const existing = findByEffectiveName(scan, params.name, method);
  const target = confinedAgentTarget(root, existing, method);
  await assertNotSymlink(target, method);
  try {
    await unlink(target);
  } catch (error) {
    failure(method, error instanceof Error ? error.message : String(error));
  }
  return s.codezAgentsDeleteResultSchema.parse({});
}

export async function handleAgentRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const dirs = resolveAgentRoleDirs(context.cwd, env);
  if (method === "agents/list") {
    const p = input(s.codezAgentsListParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return listAgentRoles(dirs);
  }
  if (method === "agents/write") {
    const p = input(s.codezAgentsWriteParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return writeAgentRole(dirs, p, method);
  }
  if (method === "agents/delete") {
    const p = input(s.codezAgentsDeleteParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return deleteAgentRole(dirs, p, method);
  }
  return invalid(method, "No Codex agents mapping");
}
