import type { CodexProcessOptions } from "./contract.js";

/** Build process-scoped overrides without touching the user's shared Codex configuration. */
export function codexServerArgv(options: CodexProcessOptions): string[] {
  // 修复原因与依据：原生 Codex 默认开启 Feature::InstantInterrupt (instant_interrupt = true)，
  // 会在收到 turn/steer（引导）时触发 StepContext.preempt.cancel() 立即掐断正在进行的模型流式
  // 思考/正文采样请求。桌面端引导的产品合同是“不打断当前在途模型请求，等当前模型步骤结束后在
  // 同轮下一次请求一并发送”，因此通过进程级配置覆盖关闭 instant_interrupt，且不污染用户 config.toml。
  const argv = ["app-server", "--listen", "stdio://", "-c", "features.instant_interrupt=false"];
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
