import { z } from "zod";

/**
 * Codez agent 提供方的单一真源。
 *
 * 类型 CodezProvider、运行时 schema codezProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / codez-protocol 等无环引用。
 */
const CODEZ_PROVIDERS = ["glm"] as const;

export const codezProviderSchema = z.enum(CODEZ_PROVIDERS);

export type CodezProvider = (typeof CODEZ_PROVIDERS)[number];
