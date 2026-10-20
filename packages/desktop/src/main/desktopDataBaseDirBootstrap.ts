import { existsSync, readFileSync } from "node:fs";
import { setDataBaseDir } from "@codez/services/node";
import { CODEZ_CREDENTIALS_FILE_ENV } from "@codez/shared/credential-security";
import {
  isCodexDesktop,
  resolveDesktopBootstrapSettingsFile,
  resolveDesktopDataBaseDir,
} from "./desktopProductRuntime.js";

export function resolveBootstrapSettingsFile(homePath?: string): string {
  return resolveDesktopBootstrapSettingsFile(homePath);
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveDesktopBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  // Bug 原因（评审 CR-01）：CODEZ_CREDENTIALS_FILE 是 Source Server Core 的进程装配，凭据路径解析
  // 会优先采用它。Desktop 从设置了该变量的 shell / launchctl 环境启动时，Main cipher、Host 凭据服务
  // 与 Agent 会整体改用外部指定的凭据库（例如 Server 自有库）。Desktop 不是该变量的合法来源，
  // 在任何凭据读写方创建、Host fork 之前删除一次，Main、Host 与 Agent 都只用 Desktop 数据根。
  delete process.env[CODEZ_CREDENTIALS_FILE_ENV];
  const configured = readBootstrapDataBaseDirFromDisk();
  const dataBaseDir = isCodexDesktop
    ? resolveDesktopDataBaseDir(configured ?? process.env.CODEZ_DATA_BASE_DIR)
    : configured;
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
