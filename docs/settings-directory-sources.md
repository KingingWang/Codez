# 设置目录来源

`command`、`mcp`、`hooks` 现在按 Codez Agent 的约定目录读取。设置页只标识配置属于 `workspace` 还是 `user`，不再把目录名展示成 CLI/provider 来源。

## 读取顺序

`command` 和 `mcp` 的固定顺序如下：

1. `<workspace>/.codez/*`
2. `<workspace>/.agents/*`（仅当 workspace `.codez` 没有有效条目时 fallback）
3. `~/.codez/*`
4. `~/.agents/*`（仅当 user `.codez` 没有有效条目时 fallback）

`command` 和 `mcp` 不再读取 `.claude`。当前 workspace 就是项目级配置边界，不在设置服务里向上扫描每一级目录。

`hooks` 仍保留兼容读取顺序：`<workspace>/.codez/*`、`<workspace>/.agents/*`、`<workspace>/.claude/*`、`~/.codez/*`、`~/.agents/*`、`~/.claude/*`。

## Command

- workspace：优先 `<workspace>/.codez/commands`；没有有效命令时 fallback 到 `<workspace>/.agents/commands`
- user：优先 `~/.codez/commands`；没有有效命令时 fallback 到 `~/.agents/commands`
- 设置页展示目录路径，不展示具体命令文件路径
- 新建/编辑只写 `.codez/commands`，通过下拉选择 user 或 workspace；`.agents` 作为兼容 fallback 来源保持只读
- 禁用命令不改 markdown 文件，统一写入 `~/.codez/cli/config.json`：`command[命令文件绝对路径].enable = false`；重新启用时删除该 override

## MCP

MCP 设置页和运行时统一使用 Codez Agent MCP source。旧通用 MCP 配置只迁移一次到 user 级 `.codez` 主配置，之后不再读取通用位置。

- workspace `.codez`：`<workspace>/.codez/config.json` 下的 `mcp.servers`
- workspace `.agents`：`<workspace>/.agents/mcp.json` 下的 `mcpServers`，仅当 workspace `.codez` 没有 MCP server 时 fallback
- user `.codez`：`~/.codez/cli/config.json` 下的 `mcp.servers`
- user `.agents`：`~/.agents/mcp.json` 下的 `mcpServers`，仅当 user `.codez` 没有 MCP server 时 fallback
- 新建/编辑只写 `.codez` 主配置，通过下拉选择 user 或 workspace；兼容 fallback 来源保持只读
- 禁用 MCP server 直接写回该 server 所在的 MCP 配置对象：`mcp.servers[serverName].enable = false` 或 `mcpServers[serverName].enable = false`；重新启用时删除该 `enable` 字段

## Hooks

- workspace `.codez`：`<workspace>/.codez/config.json` 下的 `hooks`
- workspace `.agents`：`<workspace>/.agents/settings.json` 下的 `hooks`
- workspace `.claude`：`<workspace>/.claude/settings.json` 下的 `hooks`
- user `.codez`：`~/.codez/cli/config.json` 下的 `hooks`
- user `.agents`：`~/.agents/settings.json` 下的 `hooks`
- user `.claude`：`~/.claude/settings.json` 下的 `hooks`
- 新建/编辑只写 `.codez` hooks，通过下拉选择 user 或 workspace；兼容来源 hooks 只读展示
- 表单保留 process hook 的额外 JSON 字段，避免设置页保存时丢失当前 UI 未建模的 hooks 字段
- 禁用 hook 统一写入 `~/.codez/cli/config.json`：`hooks[配置目录路径][hook 签名].enable = false`；签名由 `event`、`matcher`、`command`、`args` 组成，重新启用时删除该 override
