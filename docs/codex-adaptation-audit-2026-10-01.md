# Codex fork 适配复查（2026-10-01）

本轮以合入 `origin/main` 后的 Codez 源码、隔离的 Electron/Main/Host、
固定的 Codex 0.155.1 二进制、无认证回环模型及
`/root/workspace/codex` 只读源码对照为依据。官方
[Codex app-server 集成说明](https://developers.openai.com/blog/codex-as-a-platform)
明确把长期会话、流式事件和审批作为 app-server 的集成面；
本项目保持原生 Codex 为执行、会话和配置的权威，Codez 只负责窗口、
路由与呈现。此文不把夹具的模拟审批视作真实账号/手机远控证据。

## 边界与本轮优化

| 发现                                                                                    | 证据强度                                                                                  | 状态/处理                                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 设置内从 MCP servers 转到 Configuration/Thread history 时，标题与侧栏仍停在 MCP Servers | 真实隔离 Electron 可复现，`desktop-check.mjs` 修改前失败                                  | 已修：内层独有面板归属 Codex 外层导航，保留面板选中态；再次点外层 Codex 回 Account |
| 技能、插件与市场的多个按钮同名，读屏无法确认操作目标                                    | GUI 可交互树与截图证实                                                                    | 已修：技能路径/作用域、插件 ID/市场和市场名进入无障碍名称；视觉短标签不变          |
| 删除唯一 catalog 模型会写出 `{ "models": [] }`，但 Codex 原生拒绝空目录                 | 桥接代码、固定版本二进制错误字符串与参考源码 `load_catalog_json` 一致；桥接回归修改前失败 | 已修：bridge 本次读取后拒绝落盘，GUI 禁用并提示先添加替代模型；字节保持不变        |
| 目录写入后的「重启运行时」曾显示「确认移除」且未显示任务中断风险                        | `CodexConfirmButton` 调用点与 `disposeWorkspace` 路径证实                                 | 已修：独立「确认重启」与中断提醒；取消不调用 dispose                               |
| 隔离 GUI 回归旧脚本只认 5174/9229、或读取旧 RPC 日志快照                                | 原脚本在 5175/9231 拒绝 QA 页面；交互运行曾读到旧计数                                     | 已修：端口显式校验与目标 URL 白名单；RPC 观察等待本次检查序号                      |

所有变动先记录在
[`CodexSettings.spec.md`](../packages/ui/src/settings/codex/CodexSettings.spec.md)
与 [`codex-model-provider-management.md`](../specs/codex-model-provider-management.md)。
设置页只拥有局部选中态；目录文件由 bridge 控制面读写；Codex 的加载
规则仍为原生事实。删除模型的事件序列是：

```text
GUI 最近一次目录读数 → 禁用/解释
用户/其他入口发删除 → bridge 读取当前文件 → 过滤目标 slug
                                        ├─ 剩余 0：拒绝且不触及文件
                                        └─ 剩余 ≥1：同目录临时文件 → 原子替换
之后用户明确确认重启 → Host 释放 workspace → 原生进程重新读取目录
```

该桥接检查不声称能阻止**其他进程**随后改坏 catalog；只保证本项目不写出
空目录。桌面 `desktop-continuous` 与手机 `web-remote-replayable` 的传递语义
未修改；Web/legacy 的消息反馈门控未修改。

## 验证记录

- `pnpm build:bootstrap` 与后续 renderer 增量构建通过；完整
  `pnpm typecheck` 通过；`pnpm lint` 0 error、70 条已有 warning；
  `pnpm architecture:check --changed` 0 新违规。
- Codex 设置单测 44/44；catalog 控制面 13/13；`pnpm test:codex`
  在本轮首批 UI 修改后通过（后续 catalog 守卫需在提交后重跑）。
- 真实隔离 Electron 设置/首张图片准备检查 10/10；真实原生会话检查
  10/10（首发图片、排队编辑/删除、自动出队、抢占）；原生 retry 检查
  4/4；手动中断后继续 4/4；浏览器 React 交互夹具最终 30/30。
  证据分别在 `/tmp/codex-ui-desktop-check-E2DVs7/`、
  `/tmp/codex-ui-desktop-conversation-Um0QYA/`、
  `/tmp/codex-ui-desktop-retry-E1WDuu/`、
  `/tmp/codex-ui-interrupted-turn-gegs8T/`、
  `/tmp/codex-ui-interaction-e2e-YqHnTn/`。
- 原始 UI 探查截图与两项复现步骤保存在本地忽略目录
  `.tmp/codex-dogfood-20261001/report.md`；录屏组件在本容器报
  `ffmpeg write failed: Broken pipe`，故无有效复现视频。单测夹具
  不能证明凭据模型、远端 attachment 或真实手机重放。
- 全库 `pnpm fmt:check` 仍受 6 个未修改文件的既有格式问题影响；
  本轮改动文件单独格式检查通过。命令还提示当前 pnpm 不再读取
  `package.json` 的 `pnpm.overrides` 与 `pnpm.patchedDependencies`，
  不据此推断当前已装依赖必然错误。

## 进一步优化建议和验证边界

1. **需产品决策（高）**：供应商删除与其他 Codex 进程改写模型目录之间仍有
   TOCTOU。不能把「按钮禁用 + 再读一次」当原子事务；应确定以原生原子接口
   为权威，或撤下 GUI 删除能力并提供安全迁移路径。
2. **需协议/运行时核验（高）**：既有 spec 将空 `config/batchWrite` 用作
   catalog 热刷新，但共享校验拒绝空 edits；应在固定版本 Codex 上确认
   可验证的刷新接口，再决定改为「仅新线程/重启生效」还是改变写入合同。
3. **性能与构建（中）**：旧审查测得 280 个 eager `modulepreload`（227 个
   单图标 chunk）；正确优化方向是可证明的图标 tree-shaking，不能把所有图标
   并成大包。应在正常资源配额的宿主机比较冷启动、失败率与 bundle。
   pnpm 10 忽略旧位置覆盖配置的警告应单独做干净安装/锁文件验证后迁移，
   不在本轮修改有潜在依赖范围影响的安装配置。
4. **仍未验证（阻止“完美”宣称）**：真实 ChatGPT/API key 鉴权、外部插件
   安装与 OAuth、移动远控断线重放、跨 Host owner/lease、Windows/macOS、
   托管策略，以及本容器 inotify 紧张时的长时间 renderer 冷载/崩溃恢复。
   需隔离测试账号、配套宿主机和复现矩阵。这里的 30/30 是夹具交互数，
   不代表 GUI 的「每个行为」在每个环境均已通过。

## 子代理审查状态

架构审查指出「最后一条模型」以及重启确认缺口；两项已按源码与原生
二进制核实并修复。专用 architect 角色启动失败；另一只读子代理偏离
任务修改了参考仓库 `/root/workspace/codex`，还有一次审查任务报告
无法读取委派内容。因此不把那些结果冒充 Codez 当前增量的完整 APPROVE。
参考仓库的既有与子代理所留改动没有被本轮恢复、覆盖或纳入 Codez 提交；
在处理它们前需另行确定归属。
