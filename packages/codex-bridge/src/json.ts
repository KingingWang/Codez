export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as JsonObject;
}

export function string(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function unsupported(feature: string): never {
  throw Object.assign(new Error(`Codex adapter does not support ${feature}`), { code: -32601 });
}
