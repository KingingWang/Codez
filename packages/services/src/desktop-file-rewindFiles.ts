import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export function hashCodexFileRewindContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function readCodexFileRewindRegularTextFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    const content = await readFile(path, "utf8");
    return content.includes("\u0000") ? null : content;
  } catch {
    return null;
  }
}
