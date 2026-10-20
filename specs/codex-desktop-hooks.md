# Codex 桌面端钩子（Hooks）与原生技能目录适配

## 背景

1. **Hooks（钩子）**：
   - 原生 Codex `app-server` 支持 `hooks/list` RPC（返回每个工作区生效的 `hooks`、`warnings`、`errors`），并从用户层 `${CODEX_HOME}/hooks.json`、项目层 `<project>/.codex/hooks.json`、`config.toml` 的 `[hooks]` 以及已启用插件中发现钩子。
   - 原生 Codex 在用户层 `config.toml` 的 `features.hooks` 控制总开关（默认开启），在 `[hooks.state."<key>"]` 中持久化每条钩子的启停（`enabled`）与信任哈希（`trusted_hash`）。
2. **Commands（自定义斜杠命令）边界**：
   - Codex 原生没有独立的自定义斜杠命令运行时或 `commands/list` RPC；外部命令在 Codex 中属于迁移到技能（Skills）的概念。
   - 因此桌面端严格保留 Codex 100% 原生概念：`commands` 在 `isCodexUnsupportedSection` 中保持不支持提示，不引入非原生的命令文件扫描或 Bridge 模板展开。
3. **Composer `/` 与 `$` 面板的原生技能目录**：
   - 在已有会话或预热草稿中，前端 `useSkills` 与 `usePluginReferenceCatalog` 会携带 `sessionId` 调用 `skills/referenceCatalog` 与 `plugins/referenceCatalog`。
   - 原生 Codex 的技能与插件是工作区级实时目录（由 `skills/list` 与 `plugin/list` 按 `cwd` 提供，且支持热重载），不存在独立于工作区的会话冻结快照。Bridge 对携带 `sessionId` 的目录查询直接返回当前工作区的权威目录（`authority: "workspace"`），避免在 `/`、`$ ` 与 `@` 面板中报错。
   - `SlashCommandPlugin` 的「命令」分区自动剔除已出现在「技能」分区的同名技能条目，保证技能只在 `/` 面板的「技能」分组以 `$skill` 形式展示一次。
4. **Composer `/` 面板内建命令与中文展示风格对齐**：
   - 桌面端 Codex `readControlPresentation` 返回原生内建斜杠命令：`model`、`mode`、`plan`、`init`、`compact`、`goal`。
   - `/init [notes]` 在 `codex-bridge` 中展开为创建/更新工作区 `AGENTS.md` 的初始化指令提示词。
   - `/goal <objective>` 与 `/goal resume` / `pauseGoal` 通过 Codex 原生 `thread/goal/set`、`thread/goal/get`、`thread/goal/clear` RPC 及 `thread/goal/updated`、`thread/goal/cleared` 事件在 `codex-bridge` 中完整投影到会话 `snapshot.goal` 与 `availability.pauseGoal` / `availability.resumeGoal`。
   - **方案 A（`/model` 与 `/mode` 交互联动）**：在 `/` 面板中点选 `/model` 或 `/mode`（或直接发送无参数的 `/model`、`/mode`）立即打开 Composer 模型选择器或权限模式选择器；发送 `/mode <mode>` 或 `/model <model>` 时直接切换 Composer 的模式或模型选择，不将命令文本误当作普通用户消息发给模型。
   - **UI 图标与中英文文案**：`/` 面板中的命令、技能与子智能体条目参考 ChatGPT/Codex 官方斜杠面板风格，配备语义化图标、本地化名称与描述，并支持中英文关键词双向搜索。

## 状态所有者与事件顺序

```text
UI (CodexHooksPanel)
  ├─ 读取快照：useCodexSettings → codex/request("hooks/list", { cwds: [cwd] }) + "config/read"
  ├─ 启停/信任/总开关：useCodexSettings.run → codex/request("config/batchWrite") → workspace-config 广播 → refresh
  └─ 新增/编辑/删除 hooks.json 条目：useCodexSettings.run → codezAgentService.writeCodexHooksConfig
       → getReadOnlyClient (真实 workspace 载体) → bridge "hooks/configWrite"
       → 原子读写 ${CODEX_HOME}/hooks.json 或 <dotCodexFolder>/hooks.json → refresh
```

- **唯一事实源**：Codex 原生配置文件（`${CODEX_HOME}/hooks.json`、`<project>/.codex/hooks.json` 与用户 `config.toml`）及 `hooks/list` 的权威返回。UI 只持有未提交表单草稿。
- **载体边界**：`hooks/configWrite` 与 `agents/*`、`mcp/projectConfigWrite` 遵守同一载体铁律——通过 `getReadOnlyClient(params)` 路由到目标 workspace 所在机器的 bridge 进程，远程 SSH workspace 直接读写远端机器文件，绝不触碰本机磁盘。
- **项目层路径解析**：优先取 `config/read` 中最近一层 project layer 的 `name.dotCodexFolder`（支持校验显式传入的 `dotCodexFolder`）；项目尚未存在 `.codex/config.toml` 时回退 `<cwd>/.codex/hooks.json`。

## 产品规则

1. **导航接入**：`hooks` 纳入 `isCodexSettingsSection`，在侧栏点击「钩子」或切换 Codex 内部 `hooks` 面板时双向同步，嵌入 `SettingsPage` 时以 standalone 模式渲染；`commands` 与 `migration` 保留在 `isCodexUnsupportedSection`。
2. **总开关与状态展示**：
   - 顶部提供 `features.hooks` 总开关（默认启用）。
   - 展示 `hooks/list` 返回的 `warnings` 与 `errors`，以及未信任项目层提示（可一键信任项目）。
   - 按来源分组展示钩子：当前项目（Project `.codex/hooks.json`）、全局用户（User `~/.codex/hooks.json`）、插件与托管/其他来源（Plugin / Managed / Config，只读展示）。
3. **信任与启停**：
   - 非托管钩子（`!isManaged`）支持通过 Switch 切换启停（写入用户层 `hooks.state."<key>".enabled`）。
   - 当钩子处于 `untrusted` 或 `modified` 状态时，展示「待信任 / 已修改」徽标与「信任」按钮（写入 `hooks.state."<key>".trusted_hash = currentHash`）；存在多条待审核钩子时支持「全部信任」。
4. **新增、编辑与删除**：
   - 支持在全局（User）或当前项目（Project）的 `hooks.json` 中新增、编辑、删除 `command` 类型钩子。
   - 支持 Codex 全部 12 类钩子事件（`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`），可配置 `command`、`matcher`、`timeout`、`async` 与 `statusMessage`。

## 验收场景

1. 桌面端打开「设置 > 钩子」，可查看 `hooks/list` 的全部钩子、警告与错误，切换 `features.hooks` 总开关。
2. 在「设置 > 钩子」中新增全局或项目级命令钩子 → 对应 `hooks.json` 落盘 → 列表刷新可见，支持编辑、启停、信任与删除。
3. 桌面端打开「设置 > 命令」，显示 `CodexCapabilityNotice` 不支持提示。
4. 桌面端在新建草稿或已有会话中输入 `/` 或 `$` 时，「技能」分组正常展示全部已启用的 Codex 原生技能，无 `skills/referenceCatalog` 报错，且不与「命令」分组重复。
