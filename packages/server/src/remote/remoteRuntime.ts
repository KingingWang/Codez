import { ZCODE_PRODUCT_FLAVOR, type ZCodeProductFlavor } from "@zcode/shared";

/** 产品级部署根在进程启动时固定，所有 installer/cache/lock 共用同一个根。 */
export function resolveRemoteRuntimeLayout(
  env: NodeJS.ProcessEnv = process.env,
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
): { kind: "codex" | "legacy"; root: string } {
  const override = env.ZCODE_DESKTOP_RUNTIME?.trim();
  const codex = override === "codex" || (override !== "legacy" && flavor === "codex");
  return codex
    ? { kind: "codex", root: "~/.zcode-codex/server" }
    : { kind: "legacy", root: "~/.zcode/server" };
}

export const REMOTE_RUNTIME = resolveRemoteRuntimeLayout();
