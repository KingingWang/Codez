/** Codez 项目 ID 不属于 Codex 原生 project registry；用已有持久 threadSource 记录首次归属来源。 */
const PROJECT_SOURCE_PREFIX = "codez_project:";
export const UNCLASSIFIED_SOURCE = "codez_unclassified";
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function nativeProjectSource(projectId: string | null): string {
  if (projectId === null) return UNCLASSIFIED_SOURCE;
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Codez project identity");
  return `${PROJECT_SOURCE_PREFIX}${projectId}`;
}

export function projectOriginFromSource(
  source: string | null | undefined,
): string | null | undefined {
  if (source === UNCLASSIFIED_SOURCE) return null;
  if (!source?.startsWith(PROJECT_SOURCE_PREFIX)) return undefined;
  const projectId = source.slice(PROJECT_SOURCE_PREFIX.length);
  return PROJECT_ID.test(projectId) ? projectId : undefined;
}
