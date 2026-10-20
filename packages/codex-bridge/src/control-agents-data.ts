import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as s from "@codez/shared";
import { ControlError } from "./control-common.js";

// agents/* 的 fs/TOML 数据层（对照 control-plugin-data.ts）：托管目录扫描、
// 角色文件解析/摘要、写入安全原语。校验与请求编排在 control-agents.ts。

export interface ParsedRoleFile {
  /** 相对托管目录的路径段（不含目录本身），wire 上用 `/` 拼接。 */
  segments: string[];
  absPath: string;
  table: Record<string, unknown>;
  /** 文件内声明的 name（trim 非空）或文件名主干——与 Codex 加载回退一致。 */
  effectiveName: string;
}

export interface RoleScan {
  files: ParsedRoleFile[];
  diagnostics: s.CodezAgentRoleDiagnostic[];
}

export function agentDataInvalid(method: string, reason: string): never {
  throw new ControlError(-32602, `${method}: ${reason}`, { method, reason });
}

/** 递归扫描托管目录下的 *.toml（Codex 递归发现语义）；符号链接目录不跟随。 */
export async function scanRoleDir(dir: string, scope: s.CodezAgentRoleScope): Promise<RoleScan> {
  const files: ParsedRoleFile[] = [];
  const diagnostics: s.CodezAgentRoleDiagnostic[] = [];
  const walk = async (current: string, segments: string[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // 托管目录缺失 = 空列表，不是错误；其它读取失败向上抛。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path, [...segments, entry.name]);
        continue;
      }
      // 符号链接不是可管理的角色文件：不读取（可能指向任意位置）、不列出，如实诊断。
      // 新建路径若命中符号链接，由 assertNotSymlink 在写入前拒绝。
      if (entry.isSymbolicLink() && entry.name.endsWith(".toml")) {
        diagnostics.push({
          code: "symlink_skipped",
          message: "symbolic links are not managed as agent roles",
          severity: "warning",
          scope,
          fileName: [...segments, entry.name].join("/"),
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      const rel = [...segments, entry.name];
      const relLabel = rel.join("/");
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        diagnostics.push({
          code: "read_error",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          scope,
          fileName: relLabel,
        });
        continue;
      }
      let table: Record<string, unknown>;
      try {
        const parsed = parseToml(contents);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("role file must contain a TOML table");
        table = parsed as Record<string, unknown>;
      } catch (error) {
        diagnostics.push({
          code: "parse_error",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          scope,
          fileName: relLabel,
        });
        continue;
      }
      const declared = table["name"];
      const declaredName =
        typeof declared === "string" && declared.trim() ? declared.trim() : undefined;
      const stem = entry.name.slice(0, -".toml".length);
      files.push({
        segments: rel,
        absPath: path,
        table,
        effectiveName: declaredName ?? stem,
      });
    }
  };
  await walk(dir, []);
  const byName = new Map<string, number>();
  for (const file of files)
    byName.set(file.effectiveName, (byName.get(file.effectiveName) ?? 0) + 1);
  for (const [name, count] of byName) {
    // Codex 同层重名只保留首个并告警；列出全部文件但如实标注冲突。
    if (count > 1)
      diagnostics.push({
        code: "duplicate_name",
        message: `${count} files in this scope resolve to role name "${name}"; Codex keeps only one`,
        severity: "warning",
        scope,
      });
  }
  files.sort((a, b) => a.segments.join("/").localeCompare(b.segments.join("/")));
  return { files, diagnostics };
}

export function roleSummary(
  scope: s.CodezAgentRoleScope,
  file: ParsedRoleFile,
): s.CodezAgentRoleSummary {
  const table = file.table;
  const read = (key: string) => {
    const value = table[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const nicknames = table["nickname_candidates"];
  return {
    scope,
    name: file.effectiveName,
    ...(read("description") ? { description: read("description")! } : {}),
    ...(read("model") ? { model: read("model")! } : {}),
    ...(read("model_reasoning_effort")
      ? { modelReasoningEffort: read("model_reasoning_effort")! }
      : {}),
    ...(read("developer_instructions")
      ? { developerInstructions: read("developer_instructions")! }
      : {}),
    ...(Array.isArray(nicknames) && nicknames.every((entry) => typeof entry === "string")
      ? { nicknameCandidates: (nicknames as string[]).map((entry) => entry.trim()) }
      : {}),
    fileName: file.segments.join("/"),
  };
}

/** 托管目录 canonical 化一次：符号链接目录（如软链的 ~/.codex）保持可用，目标文件另行拒绝符号链接。 */
export async function canonicalAgentDir(dir: string, create: boolean): Promise<string> {
  if (create) await mkdir(dir, { recursive: true });
  return realpath(dir);
}

export function confinedAgentTarget(dir: string, file: ParsedRoleFile, method: string): string {
  const target = join(dir, ...file.segments);
  const rel = relative(dir, target);
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel))
    agentDataInvalid(method, "role file escapes the managed directory");
  return target;
}

export async function assertNotSymlink(target: string, method: string): Promise<void> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) agentDataInvalid(method, "refusing to write through a symbolic link");
}

/** 原子写：同目录临时文件 + rename；失败不留半成品角色文件。 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function findByEffectiveName(scan: RoleScan, name: string, method: string): ParsedRoleFile {
  const matches = scan.files.filter((file) => file.effectiveName === name);
  if (matches.length === 0) agentDataInvalid(method, `no agent role named "${name}" in this scope`);
  if (matches.length > 1)
    agentDataInvalid(
      method,
      `multiple files resolve to role name "${name}"; resolve the duplicate first`,
    );
  return matches[0]!;
}
