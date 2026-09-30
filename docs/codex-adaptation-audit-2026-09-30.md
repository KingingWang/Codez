# Codex GUI 适配审查与回归（2026-09-30）

本轮续接 [9 月 29 日的审查](codex-adaptation-audit-2026-09-29.md)，以当前
Codez 源码、`/root/workspace/codex` 的只读对照、独立 `CODEX_HOME`、
真实 Electron/Main/Host/固定版本 Codex 和无认证回环模型进行检查。
没有访问真实账号、安装外部插件或写入开发者的 Codex 配置。
原始 GUI 截图与逐步复现位于本地忽略目录
`.tmp/codex-real-gui-20260930/report.md`；它不是提交中的可移植附件。

## 本轮完成的优化

| 发现                                             | 根因与修改                                                                                                                                              | 证据                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置中的历史页要求“打开原生线程”，但任务已经打开 | SettingsPage 只传 workspace，没有传 renderer 会话选择态；现在依 identity 读取已选 session，未知远程 identity 不借用 path 桶，历史事实仍由桥接运行时提供 | 真实隔离桌面显示 3 个完成 turn；单测覆盖同路径本地/远程/空选择                                                                                                        |
| 模式菜单产生受控/非受控 Tooltip 警告             | 菜单打开时 `open` 从 `undefined` 变 `false`；模式与模型引导提示在组件全生命周期保持受控                                                                 | GUI 夹具重复开合三次，新增警告为 0                                                                                                                                    |
| 错误 JSON 误报远端写失败且警示跨页残留           | 在进入唯一 mutation 路径之前校验本地草稿；校验错误仅属于当前表单，远端失败仍由 controller 承担                                                          | 浏览器夹具断言无写 RPC；真实桌面显示局部错误，切页清除                                                                                                                |
| Codex 用量与旧数据库“读取失败/无数据”混在一起    | 桌面 Codex 页只展示 Host-owned 观察统计；Web/旧页面保持旧统计；重连、刷新和卸载使旧异步响应失效                                                         | 真实桌面只显示 Codex 观察事实；夹具模拟同 identity Host 换代后旧成功/失败乱序到达                                                                                     |
| 未报告的 cache token 被展示为 0                  | 聚合只有在每个线程都报告该类别时才给精确总数；未观察到用 `--`，明确报告 0 则仍显示 0                                                                    | 单测覆盖部分字段、多线程及空状态                                                                                                                                      |
| 回退策略提供已废弃 `untrusted` 审批选项          | 回退只展示 `on-request`/`never`，原生 managed allowlist 中的 `untrusted` 仅保留为信任级事实，不再显示为可写策略                                         | 单测；[OpenAI Sandbox 官方文档](https://developers.openai.com/codex/sandboxing)和[托管配置说明](https://developers.openai.com/codex/enterprise/managed-configuration) |

```text
UI 表单草稿 ─校验─→ Host/versioned Codex 写入 ─→ 原生 config
           └错误→ 局部表单消息；未发送写入
workspace identity + renderer 已选 session ─→ bridge 原生历史 owner
原生 token 事件 ─→ Desktop/Host 观察 owner ─→ Codex-only 用量视图
                            旧 Host 返回 ─×→ 新 Host 用量（世代失效）
```

## 审查与验收边界

改动后两个只读 subagent 分别审查代码/安全和状态边界：代码审查
`APPROVE`，架构首次为 `WATCH`（同 workspace Host 重连的过期用量响应），
补世代校验与乱序测试后复审为 `CLEAR`。四条低优先级代码建议中，
已采纳「拆开链式赋值」和「不依赖 V8 错误文案」；
“解析单元素数组会返回 undefined”被拒绝，因为输入为固定单元素且
Zod 已保证非空，不存在缺元素的返回路径；将 Codex-only 组件从
AppUsagePanel 公共渲染辅助移入另一 barrel 暂不采纳，当前依赖有向且
UsageStatsSection 已加载两种面板，这一步不能消除入口导入成本。

本地验证（最终提交后需再次复测并记录实际结果）：

- UI Codex/usage 单测 57/57，通过。
- Mock Host 浏览器交互 27/27，通过；其中真实 React 控件检查模式开合、
  本地校验、身份隔离和 Host 用量重连乱序。该夹具不证明真实远控恢复。
- `pnpm build:bootstrap`、完整 `pnpm typecheck`、`pnpm test:codex`、真实
  固定版本 bridge smoke 均通过；架构检查 0 违规。
- 桌面无认证回环会话 6/6，通过：图片首发、流式回复、busy 锁定、
  `/plan` 草稿保持、图片队列、自动出队。单独的 Desktop `desktop-check.mjs`
  的 renderer reload **仍间歇失败**，不是通过项。
- `pnpm fmt:check` 在 5 个本轮未修改的既有文件失败；本轮文件按项目
  formatter 格式化。lint 的 69 条 warnings 属现存基线，最终全命令结果
  必须单独核实。

## 未关闭风险与下轮决策

1. **跨进程模型目录引用与供应商删除没有同一个原子 owner。** 当前 UI 读取
   到零引用后，外部进程仍可在删除前添加引用。禁止把一次重读描述成消除
   TOCTOU；需要产品明确删除语义（以 Codex 自身原子接口为权威，或者移除
   GUI 删除能力并提供安全的手动迁移路径）。现有先前 subagent 对这项保持
   `REQUEST CHANGES / BLOCK`，本轮 `CLEAR` 仅覆盖当前增量。
2. **目录热刷新规范和 schema 冲突。** Spec 写着发送空
   `config/batchWrite`，共享 schema 明确拒绝空编辑；不能声称文件编辑后
   composer/所有运行中线程立即得到一致目录。需确定真实可校验的原生刷新
   合同，或改为明确的重启/新线程语义，不能靠静默重试。
3. **GUI reload 的启动画面偶发卡死。** 首次加载与真实会话可用，刷新
   30 秒无导航；另一次手动 CDP 刷新 12 秒内完成、无 failed request。
   此共享 Linux 容器 inotify 实例上限 128，基线占用约 103，曾见
   `inotify_init(): Too many open files` 和大量未完成静态资源请求。
   证据尚不足以确定是容器资源还是应用加载图问题；不能用加 timeout
   代替根因分析。
4. 外部 OAuth、真实订阅模型、管理策略、安装插件、Chrome 登录态导入、
   手机 replayable 远控、Windows/macOS 原生对话框均未在本隔离环境端到端
   执行，不得标为全 GUI 完美适配。

继续验收的优先级：先在正常资源配额的 Linux/Windows/macOS 上复测冷载、
刷新与所有本地控件；确定供应商删除/目录刷新的权威合同，再对隔离测试
账号与移动远控完成登录、审批、断线重放和危险操作确认矩阵。
