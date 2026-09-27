import type { CodexProcessOptions } from "./contract.js";

/** Build process-scoped overrides without touching the user's shared Codex configuration. */
export function codexServerArgv(options: CodexProcessOptions): string[] {
  const argv = ["app-server", "--listen", "stdio://"];
  if (options.updatePlanToolEnabled === true) {
    argv.push("-c", "tools.update_plan.enabled=true");
  }
  for (const server of options.desktopMcpServers ?? []) {
    // 修复依据：逐字段覆盖会继承用户旧注册的 enabled=false/额外 env；
    // 覆盖整张表可隔离旧配置，且不改变其它客户端。
    const env = Object.entries(server.env)
      .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`)
      .join(",");
    argv.push(
      "-c",
      `mcp_servers.${server.name}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env={${env}},enabled=true}`,
    );
  }
  return argv;
}
