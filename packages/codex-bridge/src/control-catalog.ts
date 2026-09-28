import { readFile } from "node:fs/promises";
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
 * 读取宿主 catalog 文件的 slug→provider 映射。
 * 路径不取自调用方（bridge 以用户权限运行，不开放任意路径读取面），而是经
 * config/read 取 codex 解析后的 model_catalog_json（含 profile/托管层合并）。
 */
export async function readCatalogProviderMap(
  context: BridgeControlContext,
  method: string,
): Promise<s.CodezCatalogReadResult> {
  const config = z
    .object({
      config: z.object({ model_catalog_json: z.string().nullish() }).passthrough(),
    })
    .passthrough()
    .parse(await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: false }));
  const path =
    typeof config.config.model_catalog_json === "string" && config.config.model_catalog_json.trim()
      ? config.config.model_catalog_json.trim()
      : null;
  if (!path) return s.codezCatalogReadResultSchema.parse({ path: null, models: [] });
  let parsed: z.infer<typeof catalogFileSchema>;
  try {
    parsed = catalogFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    failure(
      method,
      `failed to read model catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return s.codezCatalogReadResultSchema.parse({
    path,
    models: parsed.models
      .filter((model) => typeof model.provider === "string" && model.provider.trim())
      .map((model) => ({ slug: model.slug, provider: model.provider!.trim() })),
  });
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
  throw new ControlError(-32602, `${method}: No Codex catalog mapping`, {
    method,
    reason: "unknown_method",
  });
}
