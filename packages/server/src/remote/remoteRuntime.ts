import { CODEZ_PRODUCT_FLAVOR, type CodezProductFlavor } from "@codez/shared";

export interface RemoteRuntimeLayout {
  kind: "codex" | "legacy";
  root: string;
}

const CODEX_REMOTE_DATA_BASE_DIR = "~/.codez-codex";
const LEGACY_REMOTE_DATA_BASE_DIR = "~/.codez";

/** 产品级部署根在进程启动时固定，所有 installer/cache/lock 共用同一个根。 */
export function resolveRemoteRuntimeLayout(
  env: NodeJS.ProcessEnv = process.env,
  flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR,
): RemoteRuntimeLayout {
  const override = env.CODEZ_DESKTOP_RUNTIME?.trim();
  const codex = override === "codex" || (override !== "legacy" && flavor === "codex");
  return codex
    ? { kind: "codex", root: `${CODEX_REMOTE_DATA_BASE_DIR}/server` }
    : { kind: "legacy", root: `${LEGACY_REMOTE_DATA_BASE_DIR}/server` };
}

/**
 * 远端数据基目录：server 部署根是其下的 server/ 子目录，prompt 附件等远端私有数据
 * 挂在其下的 tmp/ 子目录。codex flavor 必须完全隔离在 ~/.codez-codex，不能泄漏到上游 ~/.codez。
 * 运行时惰性解析（含 CODEZ_DESKTOP_RUNTIME override），调用方不要缓存编译期常量。
 */
export function resolveRemoteDataBaseDir(
  layout: RemoteRuntimeLayout = resolveRemoteRuntimeLayout(),
): string {
  return layout.kind === "codex" ? CODEX_REMOTE_DATA_BASE_DIR : LEGACY_REMOTE_DATA_BASE_DIR;
}

export const REMOTE_RUNTIME = resolveRemoteRuntimeLayout();
