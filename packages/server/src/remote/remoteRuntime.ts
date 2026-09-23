import { CODEZ_PRODUCT_FLAVOR, type CodezProductFlavor } from "@codez/shared";

/** 产品级部署根在进程启动时固定，所有 installer/cache/lock 共用同一个根。 */
export function resolveRemoteRuntimeLayout(
  env: NodeJS.ProcessEnv = process.env,
  flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR,
): { kind: "codex" | "legacy"; root: string } {
  const override = env.CODEZ_DESKTOP_RUNTIME?.trim();
  const codex = override === "codex" || (override !== "legacy" && flavor === "codex");
  return codex
    ? { kind: "codex", root: "~/.codez-codex/server" }
    : { kind: "legacy", root: "~/.codez/server" };
}

export const REMOTE_RUNTIME = resolveRemoteRuntimeLayout();
