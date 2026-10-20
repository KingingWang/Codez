// 远端 Codez Agent 以「独立 node + 编译产物 codez.cjs」的形态运行，而不是各平台内嵌 node 的原生二进制。
// 远端部署时本来就有一份独立 node（用于跑 codez-server.cjs），agent 复用它执行 codez.cjs 即可。
//
// 部署布局：把 codez.cjs 放到 agents/<provider>/codez.cjs，再写一个同名 wrapper —— 就是 resolver
// 期望找到的可执行入口（如 agents/glm/codez-agent）—— 由它用远端 node 执行 codez.cjs。
// 这样 provider runtime resolver 不需要区分原生/JS，照旧找 codez-agent 这个可执行文件即可。
// 开发态与生产态共用同一份 wrapper 语义。

import { resolveRemoteRuntimeLayout, type RemoteRuntimeLayout } from "./remoteRuntime.js";

export const REMOTE_AGENT_BUNDLE_NAME = "codez.cjs";

/**
 * 布局根以 ~ 前缀表达远端 HOME；wrapper 在远端 shell 中执行，必须改写为 $HOME 保留
 * shell 展开，绝不能输出被引号包裹的字面量 ~（引号内 ~ 不展开，会指向不存在的目录）。
 */
function toShellRuntimeRoot(root: string): string {
  if (root === "~") {
    return "$HOME";
  }
  return root.startsWith("~/") ? `$HOME/${root.slice(2)}` : root;
}

/**
 * wrapper 文本按生成时的当前 flavor 布局产出（codex → ~/.codez-codex/server，legacy → ~/.codez/server）。
 * 历史版本把 fallback 与 agents 产物路径硬编码到 $HOME/.codez/server，codex flavor 远端会读写上游目录；
 * 这里把布局根单次赋值为 runtime_root，node 与 agents 产物路径统一从它派生。
 * 内容随布局变化，isRemoteAgentBundleWrapperCurrent 的内容比对会自动触发重部署。
 */
export function buildRemoteAgentBundleWrapper(
  runtimeResourceDir: string,
  layout: RemoteRuntimeLayout = resolveRemoteRuntimeLayout(),
): string {
  const shellRuntimeRoot = toShellRuntimeRoot(layout.root);
  return [
    "#!/bin/sh",
    "set -eu",
    `runtime_root="\${CODEZ_SERVER_RUNTIME_ROOT:-${shellRuntimeRoot}}"`,
    `exec "$runtime_root/node" "$runtime_root/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
  layout: RemoteRuntimeLayout = resolveRemoteRuntimeLayout(),
): boolean {
  return (
    content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir, layout)
  );
}
