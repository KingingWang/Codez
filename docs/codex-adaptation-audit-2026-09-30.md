# Codex GUI 适配审查与回归（2026-09-30）

本轮续接 [9 月 29 日的审查](codex-adaptation-audit-2026-09-29.md)，以当前
Codez 源码、`/root/workspace/codex` 的只读对照、独立 `CODEX_HOME`、
真实 Electron/Main/Host/固定版本 Codex 和无认证回环模型进行检查。
没有访问真实账号、安装外部插件或写入开发者的 Codex 配置。
原始 GUI 截图与逐步复现位于本地忽略目录
`.tmp/codex-real-gui-20260930/report.md`；它不是提交中的可移植附件。

## 本轮完成的优化

| 发现                                                                  | 根因与修改                                                                                                                                                                                                                             | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置中的历史页要求“打开原生线程”，但任务已经打开                      | SettingsPage 只传 workspace，没有传 renderer 会话选择态；现在依 identity 读取已选 session，未知远程 identity 不借用 path 桶，历史事实仍由桥接运行时提供                                                                                | 真实隔离桌面显示 3 个完成 turn；单测覆盖同路径本地/远程/空选择                                                                                                                                                                                                                                                                                                                                                                                    |
| 模式菜单产生受控/非受控 Tooltip 警告                                  | 菜单打开时 `open` 从 `undefined` 变 `false`；模式与模型引导提示在组件全生命周期保持受控                                                                                                                                                | GUI 夹具重复开合三次，新增警告为 0                                                                                                                                                                                                                                                                                                                                                                                                                |
| 错误 JSON 误报远端写失败且警示跨页残留                                | 在进入唯一 mutation 路径之前校验本地草稿；校验错误仅属于当前表单，远端失败仍由 controller 承担                                                                                                                                         | 浏览器夹具断言无写 RPC；真实桌面显示局部错误，切页清除                                                                                                                                                                                                                                                                                                                                                                                            |
| Codex 用量与旧数据库“读取失败/无数据”混在一起                         | 桌面 Codex 页只展示 Host-owned 观察统计；Web/旧页面保持旧统计；重连、刷新和卸载使旧异步响应失效                                                                                                                                        | 真实桌面只显示 Codex 观察事实；夹具模拟同 identity Host 换代后旧成功/失败乱序到达                                                                                                                                                                                                                                                                                                                                                                 |
| 未报告的 cache token 被展示为 0                                       | 聚合只有在每个线程都报告该类别时才给精确总数；未观察到用 `--`，明确报告 0 则仍显示 0                                                                                                                                                   | 单测覆盖部分字段、多线程及空状态                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 回退策略提供已废弃 `untrusted` 审批选项                               | 回退只展示 `on-request`/`never`，原生 managed allowlist 中的 `untrusted` 仅保留为信任级事实，不再显示为可写策略                                                                                                                        | 单测；[OpenAI Sandbox 官方文档](https://developers.openai.com/codex/sandboxing)和[托管配置说明](https://developers.openai.com/codex/enterprise/managed-configuration)                                                                                                                                                                                                                                                                             |
| 桌面用量指标标签在窄宽度被省略号截断                                  | 指标标签由 `truncate` 改为 `break-words`，保留完整词；规范要求五个标签在常规与窄宽度下都可读                                                                                                                                           | 真实桌面截图 `usage-labels-wrapped-final.png`；交互夹具在 1200px 与 390px 断言标签完整可见                                                                                                                                                                                                                                                                                                                                                        |
| 崩溃/强杀后原生 Browser/CUA endpoint 残留，能力永久不可用且无自助恢复 | 绑定前先探测 endpoint 是否仍有活着的监听者：连不上才删除残留文件并重绑一次；连得上说明另一实例在服役，保持 fail-closed 不删其凭据；Windows 命名管道不回收                                                                              | 真实桌面复现 00:04 残留 socket 使后续启动两次 EADDRINUSE；修复后同一路径回收并重绑（socket 时间戳 00:04→09:33），干净退出由属主删除；单测用 SIGKILL 子进程制造残留并验证回收后仍能服务请求，变异测试确认去掉回收即失败                                                                                                                                                                                                                            |
| renderer 崩溃或模块图失败后留下永久空白/死窗口                        | 主进程对主窗口可恢复原因的 `render-process-gone` 做有界原地 reload（延迟一个宏任务并复查存活性，最多 2 次）；renderer 内联看门狗在模块图失败时自动重试一次，之后渲染无依赖错误面（含 Reload 与技术细节），3s 兜底不再伪装 React 已挂载 | renderer 侧已真实验证：手动 reload 触发 `net::ERR_INSUFFICIENT_RESOURCES` 模块缺失时，空白页变为可操作错误面，Reload 按钮点击后重新装载（截图 `bootstrap-failure-surface.png`）；启动期 renderer crash（exit 133）确实发生且恢复接线触发，但首版接线误用 `window.setTimeout`（主进程无 window）抛 ReferenceError 使 reload 未执行，审查发现后已改为 Node 全局 `setTimeout` 并加回归守护测试；修复后的崩溃恢复尚未在本容器再次复现崩溃以端到端验证 |

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

本轮增量（配置草稿错误上下文、供应商删除判定合一、图标分包回退）再次交由
代码审查与架构两条只读 subagent 复核，结论记录在
[codex-gui-review-2026-09-30.md](codex-gui-review-2026-09-30.md)。上一轮
MEDIUM#1「JSON 解析错误缺少上下文」已采纳：新增双语 `invalidJsonSyntax`
与单次扫描的 `formatCodexTemplate`，单值与批量两个草稿校验分支共用同一
描述函数，schema 与远端错误仍保留各自可执行文案。上一轮 MEDIUM#2
「供应商删除的 `catalogReady` 早退冗余、`setFormError` 路径不可达」
**部分驳回**：按钮确实已禁用（交互夹具断言其 disabled 状态），但
`specs/codex-model-provider-management.md` 要求「禁用按钮和命令入口」两处
都 fail-closed，删除是对原生配置的破坏性写入，其不变量不能只依赖渲染期
prop；审查真正指出的问题是「两条校验路径」，已通过把两处判定收敛为纯函数
`codexProviderDeleteBlock` 消除，而不是删掉写入前的判定。LOW 项按其结论
保持现状（schema 已保证非空，防御性断言不掩盖原始错误）。

本地验证（最终提交后需再次复测并记录实际结果）：

- UI Codex/usage 单测 59/59，通过；其中 `codexSettings` 28、`CodexPanels` 14，含配置草稿错误双语上下文与供应商删除判定的四个分支。
- Mock Host 浏览器交互 28/28，通过；其中真实 React 控件检查模式开合、
  本地校验、身份隔离和 Host 用量重连乱序。该夹具不证明真实远控恢复。
- `pnpm build:bootstrap`、完整 `pnpm typecheck`、`pnpm test:codex`、真实
  固定版本 bridge smoke 均通过；架构检查 0 违规。
- 桌面无认证回环会话 6/6，通过：图片首发、流式回复、busy 锁定、
- 本轮真实桌面复测：会话检查再次 6/6（`/tmp/codex-ui-desktop-conversation-JQEgm3`，
  发送延迟 426ms/362ms），该次为干净启动；启动期 renderer 崩溃的恢复路径见上表说明。
- 桌面新增单测 14/14（broker 9、bootstrap shell 3、crash recovery 2）；
  `packages/desktop/src/main` 的 `tsc -b` 错误数与改动前完全一致（86，均在我未触碰文件）。
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
3. **GUI reload 的失败根因已定位到两个层次。** renderer 层：reload 时约 250 个
   dev-server 模块请求中个别关键模块返回 `net::ERR_INSUFFICIENT_RESOURCES`，
   入口模块缺失导致 React 永不挂载；更严重时 renderer 直接原生崩溃
   （`render-process-gone` reason=crashed，exit 133）。宿主层：本容器
   `fs.inotify.max_user_instances=128` 且为只读，约 101 个实例被环境自带的
   XFCE/dbus/Chrome 长驻进程（68–84 天）占用，`fs.watch` 因此 EMFILE。
   应用侧已补两层恢复（主进程有界 reload + renderer 看门狗错误面），但
   renderer 原生崩溃在资源配额正常的宿主机上是否复现仍未验证，
   `desktop-check.mjs` 在本容器仍不能稳定通过，不记为通过项。

4. **两项由本轮审查提出、未擅自改动的既有优化点。** 一是 `lucide-react` 的
   barrel 导入让主窗口产生 280 个 `modulepreload`（其中 227 个是单图标
   chunk）；正确方向是让打包器只保留实际使用的图标，而不是把它们合并成一个
   约 568KB 的巨型 chunk。二是 `packages/ui/src/i18n/IntlProvider.tsx` 的
   `formatMessage` 逐 key `replaceAll`，当传入值本身含 `{otherKey}` 时会发生
   二次替换；这属全局 i18n 行为，需与用户对齐后再改，本轮只在 Codex 目录内
   使用单次扫描实现。

继续验收的优先级：先在正常资源配额的 Linux/Windows/macOS 上复测冷载、
刷新与所有本地控件；确定供应商删除/目录刷新的权威合同，再对隔离测试
账号与移动远控完成登录、审批、断线重放和危险操作确认矩阵。
