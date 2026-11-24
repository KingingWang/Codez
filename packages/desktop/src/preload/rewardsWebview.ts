import { contextBridge } from "electron";
import { installRewardsPageBridge, isTrustedRewardsUrl } from "@codez/shared";

// 普通网页和三方导航不能继承邀请页的 bridge；仅宿主批准的开发模式允许 localhost。
if (
  isTrustedRewardsUrl(window.location.href, {
    dev: process.argv.includes("--codez-rewards-dev"),
    e2e: process.env.VITE_CODEZ_E2E_STORE_BRIDGE === "1",
  })
) {
  contextBridge.executeInMainWorld({ func: installRewardsPageBridge, args: [] });
}
