import { codexConfigEditsSchema } from "@codez/shared";

/** Validate form drafts before entering the remote mutation/error path. */
export function parseCodexConfigValueEdit(keyPath: string, jsonValue: string) {
  const parsed = codexConfigEditsSchema.parse([
    { keyPath: keyPath.trim(), value: JSON.parse(jsonValue), mergeStrategy: "replace" },
  ]);
  if (parsed.length !== 1) {
    throw new Error(`Expected exactly one config edit, got ${parsed.length}`);
  }
  return parsed[0];
}

export function parseCodexConfigBatchEdits(batch: string) {
  return codexConfigEditsSchema.parse(JSON.parse(batch));
}
