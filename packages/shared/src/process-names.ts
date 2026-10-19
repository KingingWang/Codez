const CODEZ_PROCESS_PREFIX = "codez";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinCodezProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [CODEZ_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatCodezMainProcessName(): string {
  return joinCodezProcessName("main");
}

export function formatCodezGpuProcessName(): string {
  return joinCodezProcessName("gpu");
}

export function formatCodezHostProcessName(label?: string): string {
  return joinCodezProcessName("host", label);
}

export function formatCodezRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "Codez") {
    return joinCodezProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinCodezProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "Codez - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinCodezProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinCodezProcessName("renderer", normalizedTitle);
}

export function formatCodezAgentProcessName(provider: string, workspacePath?: string): string {
  return joinCodezProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatCodezUtilityProcessName(name?: string, type = "utility"): string {
  return joinCodezProcessName(type, name);
}
