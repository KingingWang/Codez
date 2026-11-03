import type { CodezSessionFile, CodezTaskMeta } from "@codez/shared";
import { codezSessionFileSchema, codezTaskMetaSchema, codezTaskModeSchema } from "@codez/shared";

export type LegacyTaskSessionFile = Omit<CodezSessionFile, "meta"> & {
  meta: Omit<CodezTaskMeta, "mode"> & { mode?: CodezTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = codezSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: codezTaskMetaSchema.extend({
    mode: codezTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
