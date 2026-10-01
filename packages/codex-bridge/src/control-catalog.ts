import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import * as s from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { ControlError, checkWorkspace, input } from "./control-common.js";

// Codex 模型目录（model_catalog_json）读取。catalog/* 是 bridge 本地 fs 控制面
// 方法族——codex app-server 的 model/list 不携带 per-model provider（v2 Model 无
// 此字段，catalog 的 provider 在 ModelInfo→ModelPreset 转换中丢失），绝不能进入
// codex/request 原生白名单。多 provider 分组事实的唯一来源是该目录文件：
// codex 远端 catalog 从不设置 ModelInfo.provider。
// 合同与失败语义见 specs/codex-model-provider-grouping.md。

/** catalog JSON 顶层形状：codex 按 ModelsResponse 解析（`{ models: [...] }`）。 */
const catalogFileSchema = z.object({
  models: z.array(
    z
      .object({
        slug: z.string(),
        provider: z.string().optional(),
      })
      .passthrough(),
  ),
});

function failure(method: string, reason: string): never {
  throw new ControlError(-32000, `${method}: ${reason}`, { method, reason: "upstream_failure" });
}

/**
 * 解析宿主 catalog 文件路径。路径不取自调用方（bridge 以用户权限运行，不开放
 * 任意路径读写面），而是经 config/read 取 codex 解析后的 model_catalog_json
 * （含 profile/托管层合并）。返回 null = 未配置目录文件。
 */
async function resolveCatalogPath(context: BridgeControlContext): Promise<string | null> {
  const config = z
    .object({
      config: z.object({ model_catalog_json: z.string().nullish() }).passthrough(),
    })
    .passthrough()
    .parse(await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: false }));
  return typeof config.config.model_catalog_json === "string" &&
    config.config.model_catalog_json.trim()
    ? config.config.model_catalog_json.trim()
    : null;
}

/** 读取并解析 catalog 文件；missingOk 时文件不存在按空目录处理（管理写路径）。 */
async function readCatalogFile(
  method: string,
  path: string,
  missingOk: boolean,
): Promise<z.infer<typeof catalogFileSchema>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (missingOk && (error as NodeJS.ErrnoException)?.code === "ENOENT") return { models: [] };
    failure(
      method,
      `failed to read model catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return catalogFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    failure(
      method,
      `failed to parse model catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function catalogMapping(
  path: string | null,
  models: readonly { slug: string; provider?: string }[],
): s.CodezCatalogReadResult {
  return s.codezCatalogReadResultSchema.parse({
    path,
    models: models
      .filter((model) => typeof model.provider === "string" && model.provider.trim())
      .map((model) => ({ slug: model.slug, provider: model.provider!.trim() })),
  });
}

/** 同目录 tmp + rename 原子落盘，避免半截 JSON 被 codex/并发读者捡到。 */
async function writeCatalogFileAtomic(
  method: string,
  path: string,
  models: readonly unknown[],
): Promise<void> {
  const tmp = join(dirname(path), `.codez-catalog-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    failure(
      method,
      `failed to write model catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 读取宿主 catalog 文件的 slug→provider 映射。
 * 路径不取自调用方（bridge 以用户权限运行，不开放任意路径读取面），而是经
 * config/read 取 codex 解析后的 model_catalog_json（含 profile/托管层合并）。
 */
export async function readCatalogProviderMap(
  context: BridgeControlContext,
  method: string,
): Promise<s.CodezCatalogReadResult> {
  const path = await resolveCatalogPath(context);
  if (!path) return catalogMapping(null, []);
  return catalogMapping(path, (await readCatalogFile(method, path, false)).models);
}

/** catalog/readModels：返回完整原始条目（管理表单与单模型高级 JSON 编辑器用）。 */
async function readCatalogModels(
  context: BridgeControlContext,
  method: string,
): Promise<s.CodezCatalogReadModelsResult> {
  const path = await resolveCatalogPath(context);
  if (!path) return s.codezCatalogReadModelsResultSchema.parse({ path: null, models: [] });
  return s.codezCatalogReadModelsResultSchema.parse({
    path,
    models: (await readCatalogFile(method, path, true)).models,
  });
}

/** catalog/writeModel：按 slug upsert（同 slug 整条替换，否则追加），原子落盘。 */
async function writeCatalogModel(
  context: BridgeControlContext,
  method: string,
  model: s.CodezCatalogModelEntry,
): Promise<s.CodezCatalogReadResult> {
  const path = await resolveCatalogPath(context);
  if (!path) failure(method, "model_catalog_json is not configured");
  const existing = await readCatalogFile(method, path, true);
  const index = existing.models.findIndex((entry) => entry.slug === model.slug);
  const models = [...existing.models];
  if (index >= 0) models[index] = model;
  else models.push(model);
  await writeCatalogFileAtomic(method, path, models);
  return catalogMapping(path, models);
}

/** catalog/deleteModel：按 slug 删除；不存在时报未找到（调用方据此提示）。 */
async function deleteCatalogModel(
  context: BridgeControlContext,
  method: string,
  slug: string,
): Promise<s.CodezCatalogReadResult> {
  const path = await resolveCatalogPath(context);
  if (!path) failure(method, "model_catalog_json is not configured");
  const existing = await readCatalogFile(method, path, true);
  const models = existing.models.filter((entry) => entry.slug !== slug);
  if (models.length === existing.models.length) {
    failure(method, `model "${slug}" not found in catalog ${path}`);
  }
  // Codex 启动期拒绝已配置的空目录；只校验 UI 上一次读取会有竞态，
  // 因此必须在 bridge 本次读取后、原子写入前守住最后一条模型。
  if (models.length === 0) failure(method, "model_catalog_json must retain at least one model");
  await writeCatalogFileAtomic(method, path, models);
  return catalogMapping(path, models);
}

export async function handleCatalogRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
): Promise<unknown> {
  if (method === "catalog/read") {
    const p = input(s.codezCatalogReadParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return readCatalogProviderMap(context, method);
  }
  if (method === "catalog/readModels") {
    const p = input(s.codezCatalogReadModelsParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return readCatalogModels(context, method);
  }
  if (method === "catalog/writeModel") {
    const p = input(s.codezCatalogWriteModelParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return writeCatalogModel(context, method, p.model);
  }
  if (method === "catalog/deleteModel") {
    const p = input(s.codezCatalogDeleteModelParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    return deleteCatalogModel(context, method, p.slug);
  }
  throw new ControlError(-32602, `${method}: No Codex catalog mapping`, {
    method,
    reason: "unknown_method",
  });
}
