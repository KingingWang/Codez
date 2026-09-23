import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodezStdioTapDevState } from "@codez/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface CodezStdioTapStateFile {
  enabled?: boolean;
}

function isCodezStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getCodezStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getCodezStdioTapDevLogDir(): string {
  return join(getCodezStdioTapDevDir(), "stdio-traffic");
}

function getCodezStdioTapDevStatePath(): string {
  return join(getCodezStdioTapDevDir(), "codez-stdio-tap.json");
}

function readStateFile(path: string): CodezStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CodezStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readCodezStdioTapDevState(): CodezStdioTapDevState {
  const visible = isCodezStdioTapDevVisible();
  const statePath = getCodezStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getCodezStdioTapDevLogDir(),
    statePath,
  };
}

export function setCodezStdioTapDevEnabled(enabled: boolean): CodezStdioTapDevState {
  const visible = isCodezStdioTapDevVisible();
  const statePath = getCodezStdioTapDevStatePath();
  mkdirSync(getCodezStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readCodezStdioTapDevState();
}
