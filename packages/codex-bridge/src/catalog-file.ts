import { randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { codezCatalogModelEntrySchema } from "@codez/shared";
import { ControlError } from "./control-common.js";

/** 原生目录结构；模型 visibility 兼容归一，其他能力和目录顶层字段保留。 */
const catalogFileSchema = z
  .object({
    models: z.array(
      codezCatalogModelEntrySchema.extend({
        // 磁盘身份只能校验、不能 trim；更新其他模型时必须保留未编辑条目的原始 slug。
        slug: z.string().refine((value) => value.trim().length > 0),
        provider: z.string().optional(),
      }),
    ),
  })
  .passthrough();
type CatalogFile = z.infer<typeof catalogFileSchema>;

function failure(method: string, operation: string, path: string, error: unknown): never {
  throw new ControlError(
    -32000,
    `${method}: failed to ${operation} model catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    { method, reason: "upstream_failure" },
  );
}

/** missingOk 仅用于已有管理面的缺失文件语义，不吞掉其他读取/解析错误。 */
export async function readCatalogFile(
  method: string,
  path: string,
  missingOk: boolean,
): Promise<CatalogFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (missingOk && (error as NodeJS.ErrnoException)?.code === "ENOENT") return { models: [] };
    failure(method, "read", path, error);
  }
  try {
    return catalogFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    failure(method, "parse", path, error);
  }
}

/** 同目录临时文件 + rename；保留链接和权限，不宣称跨进程条件提交。 */
export async function writeCatalogFileAtomic(
  method: string,
  path: string,
  catalog: { models: readonly unknown[]; [key: string]: unknown },
): Promise<void> {
  let target = path;
  let mode = 0o600;
  try {
    // 原因：直接 rename 到符号链接会删掉链接，且默认权限会扩大私有目录文件的可读范围。
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") failure(method, "read", path, error);
  }
  const tmp = join(dirname(target), `.codez-catalog-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (error) {
    failure(method, "write", path, error);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 启动前仅迁移已确认的历史拼写，坏 JSON/未知枚举交由原生诊断。 */
export async function migrateLegacyCatalogVisibility(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const catalog = catalogFileSchema.safeParse(parsed);
  if (!catalog.success) return false;
  const original = parsed as { models: Record<string, unknown>[] };
  if (!original.models.some((model) => model.visibility === "hidden")) return false;
  // 修复依据：目录解析失败会阻断原生配置读取，不能等控制面解析路径后才修复；
  // 只改模型顶层枚举，保留原字节备份用于回退，不替换任意嵌套的同名字段。
  const target = await realpath(path);
  const mode = (await stat(target)).mode & 0o777;
  const backup = join(dirname(target), `.codez-catalog-${randomUUID()}.bak`);
  await writeFile(backup, raw, { encoding: "utf8", flag: "wx", mode });
  await chmod(backup, mode);
  // 迁移从原始对象只替换 visibility，不把协议归一化扩大成模型身份或其他字段的改写。
  await writeCatalogFileAtomic("catalog/migrateVisibility", target, {
    ...(parsed as Record<string, unknown>),
    models: original.models.map((model) =>
      model.visibility === "hidden" ? { ...model, visibility: "hide" } : model,
    ),
  });
  return true;
}
