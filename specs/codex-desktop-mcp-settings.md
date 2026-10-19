# Codex 桌面端 MCP 服务管理设置

## 背景

桌面端「设置 > MCP 服务」此前只有只读面板（`CodexMcpPanel`）：列出
`mcpServerStatus/list` 的运行态，支持「重载」与 OAuth 登录，没有查看全部配置、
添加、删除、使能/失能能力。完整的 MCP 管理 UI（`McpSettingsSection`）只挂在非桌面
路由，管理的是 ZCode 旧配置（`~/.codez/cli/config.json` 等），Codex 运行时不读取它。
按 `specs/codex-desktop-capabilities.md` 的原则，Codex 桌面的设置必须读写 Codex
原生配置并反映 Codex 状态。

本文档定义 Codex 桌面（含远程 workspace）MCP 服务管理的产品规则与实现边界。
以下行为均在 pinned Codex app-server（0.157.1）上实测确认。

## 实测确认的原生行为（实现的依据）

1. `config/read {cwd, includeLayers:true}` 返回：
   - `config.mcp_servers`：合成后的有效配置（注入默认键 `enabled/environment_id/
tool_timeout_sec` 等），含 user/project 两层合并结果。
   - `layers[]`：user 层带 `name.file` 与 `version`；project 层带
     `name.dotCodexFolder`（不是 `file`），未信任时带 `disabledReason` 且不进
     有效配置；project 配置文件不存在时整个 project 层不出现。
   - `origins`：以叶子 keyPath（如 `mcp_servers.<name>.command`）记录每个值来源
     的 layer 与 version。
2. `config/batchWrite` **只允许写 user 层**；写 project 文件返回
   `configLayerReadonly`（"Only writes to the user config are allowed"）。
   `expectedVersion` 冲突返回 `configVersionConflict`，因此写入前必须 fresh read。
   `value:null + mergeStrategy:"replace"` 删除 key（整条目与子键均可）。
3. project 配置路径解析与 Codex 一致：从 cwd 向上找 `.git` 根，
   配置为 `<git根>/.codex/config.toml`；无 git 仓库时用 `<cwd>/.codex/config.toml`。
4. project 层受 Codex 信任模型约束：未信任时不加载。信任可经 user 层写入
   `projects."<项目根>".trust_level = "trusted"`，再 `config/mcpServer/reload`
   即时生效。信任同时启用项目 hooks/exec 策略，必须是用户显式动作。
5. 外部直接改 project 配置文件后，`config/mcpServer/reload` + `config/read`
   能读到最新内容；`mcpServerStatus/list` 包含 disabled server
   （`runtimeStatus: null`）。

## 产品规则

设置 > MCP 服务（Codex 面板）展示并管理当前 workspace 生效的全部 MCP 服务：

1. **可见性**：列表 = `config/read` 有效配置 `mcp_servers` 的全集（含 disabled），
   按来源分组：项目（project 层）/ 全局（user 层）/ 内置（system、`-c` 注入等
   非 user/project 来源，只读展示，如 `codez-desktop-browser-cua` 由既有
   `CodexNativeBrowserCuaCard` 管理）。
2. **每个条目展示**：名称、来源分组、启停状态、运行态（连接状态/工具数/认证态，
   来自 `mcpServerStatus/list` 按名合并）。
3. **操作**：
   - 添加：选择目标来源（全局 / 当前项目），表单或 JSON 两种模式录入。
   - 编辑：修改任意字段；编辑读到的是**所属层的原始条目**（layer config 是文件
     原文，不含合成默认键），保存时整个条目 read-modify-write 回写，保留未知键。
   - 删除：确认后删除（user 层经 `value:null`；project 层经服务删除）。
   - 使能/失能：写 `mcp_servers.<name>.enabled`。失能保留配置；使能移除
     `enabled:false`（恢复默认启用）。
   - OAuth 登录：保持既有 `mcpServer/oauth/login` 流程。
4. **同名覆盖**：project 层与 user 层同名时按 Codex 合并语义 project 优先；
   UI 在条目上标注「被项目配置覆盖/覆盖全局配置」。
5. **项目未信任**：project 层 `disabledReason` 非空时，项目组展示提示并提供
   「信任此项目」动作（写 user 层 `projects."<项目根>".trust_level`）；文案必须
   说明这会同时启用项目级 hooks 与 exec 策略。
6. **内置条目只读**：非 user/project 来源的条目不显示编辑/删除/启停操作。

## 状态所有者与写入路径

- 唯一事实源是 Codex 配置文件；UI 不保存第二份 MCP 配置缓存（`mcpStore` 是
  ZCode 旧运行时的 store，本功能不复用）。
- **user 层（全局）写入**：UI → `useCodexSettings` controller →
  `codezAgentService.codexRequest` → codex-bridge 白名单 → 原生
  `config/batchWrite`（fresh `config/read` 取 `filePath/expectedVersion`）
  → `config/mcpServer/reload` → 刷新快照。
- **project 层（项目）写入**：原生 RPC 禁写，由 codex-bridge 控制面新增
  `mcp/projectConfigWrite` 承载（与 `agents/write` 同一模式）：bridge 进程运行在
  workspace 所属机器上（本地/远程天然一致），对项目 `.codex/config.toml` 做
  TOML read-modify-write（smol-toml，复用 `writeFileAtomic` 同目录临时文件 +
  rename），随后由 bridge 直接调原生 `config/mcpServer/reload` 生效。
  - 目标文件解析：优先取 `config/read` project 层 `name.dotCodexFolder`
    （Codex 自 cwd 向上层叠发现的最近 `.codex`，可信来源）；project 层不存在
    （尚未有任何 `.codex/config.toml`）时回退 `<cwd>/.codex/config.toml`
    （cwd 永远在 Codex 发现路径上）。
  - TOML 重写不保留手写注释/格式（smol-toml 限制），属于已接受的取舍。
- **并发与冲突**：写操作一律「fresh read → 立即写」，冲突（
  `configVersionConflict` / 文件内容漂移）报错提示用户刷新重试，不自动重试；
  UI 复用 controller 的 mutation lock（`busy`）串行化面板内写入。
- **事件顺序**：写入成功 → `config/mcpServer/reload` → 刷新 `config/read` 与
  `mcpServerStatus/list` 快照 → 渲染。bridge 在 `config/batchWrite` 后已广播
  `workspace-config` 变更；project 层直接写文件不经 bridge，reload 由 UI 显式触发。

## 接口

### shared（packages/shared/src/codex-runtime.ts）

- `configSourceSchema` 增加 `dotCodexFolder: z.string().optional()`（project 层
  地址来源；zod 默认剥离未知键，不显式声明就拿不到）。

### 协议与 bridge（mcp/projectConfigWrite）

- `packages/shared/src/codez-protocol/index.ts` 新增动词
  `mcpProjectConfigWrite: "mcp/projectConfigWrite"` 与 params/result zod schema：

```ts
params: { workspace: CodezWorkspaceRef, action: "upsert" | "delete" | "set-enabled",
          name: string, config?: Record<string, unknown>, enabled?: boolean }
result: { configFilePath: string, projectRoot: string }
```

- `codezAgentService.writeCodexProjectMcpConfig` 与 `agents/*` 同一载体铁律：
  走真实 workspace carrier（`getReadOnlyClient`），远程 workspace 落到远端 bridge。
- bridge `control-mcp.ts` 实现：校验（`checkWorkspace` + 名称
  `/^[A-Za-z0-9_-]+$/`）→ 解析目标文件 → TOML read-modify-write（保留
  mcp_servers 之外的既有内容）→ 原子写 → `config/mcpServer/reload`。
- `upsert` 整体替换该 server 条目；`delete` 移除；`set-enabled` 只改 `enabled`
  键（使能时删除该键，恢复 Codex 默认启用）。
- 文件不存在时按 `{ mcp_servers: {} }` 起点创建（含 `.codex` 目录）。
- user 层同名条目的 keyPath 写入（`mcp_servers.<name>.*`）只支持 TOML 裸键口径，
  因此 GUI 新建/编辑统一要求名称匹配 `/^[A-Za-z0-9_-]+$/`；存量不合规名称
  只读展示并提示（不强行改写）。

### UI（packages/ui/src/settings/codex/）

- `codexMcpSettings.ts`：纯函数数据层——从 `CodexConfigResponse` +
  status list 构建 `CodexMcpServerEntry[]`（名称/来源/启停/原始条目/运行态），
  以及 user 层写入请求的构造（复用 `codexUserConfigTarget`）。
- `CodexMcpServerForm.tsx`：添加/编辑表单（stdio/http 两类；env 与 headers 用
  键值编辑；高级 JSON 模式）。
- `CodexResourcesPanel.tsx` 的 `CodexMcpPanel` 扩展为管理面板。

## 验收场景

1. 桌面端打开设置 > MCP 服务，能看到全局（user 层）与项目（project 层）全部
   MCP 服务，含已失能项；内置注入项只读展示。
2. 添加全局 stdio/http 服务 → `~/.codex/config.toml` 出现条目 → reload 后
   `mcpServerStatus/list` 可见。
3. 失能/使能切换后文件与状态列表同步；失能项保留配置。
4. 删除后条目从文件与列表消失。
5. 项目级：写入 `<git根>/.codex/config.toml`；项目未信任时提示并可一键信任，
   信任后项目服务生效。
6. 远程 workspace：全局写远端机器的 user config；项目写远端 workspace 的
   `.codex/config.toml`；全程不触碰本机文件。
7. 并发：面板写入期间 `busy` 锁定；`configVersionConflict` 显示错误不自动重试。
