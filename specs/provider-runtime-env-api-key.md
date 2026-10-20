# 模型供应商临时环境变量 Key

Status: 实现中；实机 SSH、运行中更新时序与人工验收未完成。仅适用于普通模型供应商的手工 API Key，不适用于账号型 Provider、Codex 原生供应商或开发模式的 Server remote。

## 产品规则

- 模型供应商的手工 Key 提供「配置文件」（现有行为、旧配置默认）和「临时环境变量」两种模式。后一模式由 App 生成专用变量名；用户在 App 中输入 Key，本机 Codez Credential Store 保存值，Personal Provider Config 只保存变量引用，不回显 Key。
- 本地工作区从本机 Credential Store 为 Agent 启动提供该变量。SSH、WSL、Docker 工作区由 Desktop Local Host 在连接时读取同一凭据，经已建立的可信连接临时传给各自的 Remote Host；远端正式 Provider Config 只保存引用。不能把值拼进远端 shell 命令、Provisioning 持久化信封、Main/Renderer 状态、任务快照或日志。
- 远端 Host 内存拥有连接期 Key；它在 Agent 启动时定向注入变量。Agent 启动后从环境中捕获给模型执行私有存储，Bash、MCP、插件和其它工具子进程不得继承；缺值须在模型网络请求前失败，不回退到历史明文 Key。
- 远端正式配置继续由目标 Environment 的 Store/Registry 拥有；Environment 级配置 Provisioning 仍 single-flight，临时凭据则必须向该 Environment 的**每条在线连接**分别安装。连接就绪须等待该连接配置与临时凭据都成功；旧目标不支持时 fail-closed，绝不降级为明文同步。
- 从未安装过临时 Key 且当前没有引用时，不调用新增 RPC，旧目标的配置文件模式保持可用；同一在线连接从临时模式切回配置文件时，必须发送空集合清除已安装的内存 Key。开发模式 Server remote 收到含临时引用的 v3 配置时，在写入目标 Store 前拒绝，也不传输 Key。
- 直接写配置模式保留当前 Local → Remote 同步行为。切换到临时模式时，成功事务移走当前 Personal Config 的明文 Key 并写入本机 Credential Store；下次 Provisioning 在远端正式配置中删除该明文。已经分发过的旧 Key 可能留在历史副本中，UI 提醒用户轮换。
- 运行中修改、清除 Key 或切换模式，先展示中断提示并确认，再停止旧 Agent、使既有已接受输入按当前 CLI 重启规则收口，提交新 Key/配置并启动新 Agent；取消不写入。主动关闭远端连接可等待当前任务结束或强制断开；意外断网沿现有 stdio/SSH 断线清理，不支持离线继续运行。
- 在线配置刷新失败时，不能继续将新 Key 安装到旧配置上；涉及临时 Key 的连接须关闭或明确不可用。迟到的旧代安装不能覆盖较新的配置/凭据。
- 手机 Web 只复用桌面现有 Host attachment，不另起 Agent 或独立 Key owner。Desktop continuous 与手机 replayable 的会话投递、队列、owner/lease、`workspaceIdentity?.trim() || workspacePath` 均不因 Key 模式变化而重定义。

## 状态与事件顺序

```text
设置 UI 草稿
  → Local Host 单一保存入口：Credential Store + Personal Config（失败回滚、只通知一次）
  → Main Environment coordinator：只调度配置同步元数据
  → 一个 Window Host：复制不含临时 Key 的 Personal Config 到 Remote Store
  → 每个在线 Window Host：通过可信 RPC 把本机 Key 安装到对应 Remote Host 内存
  → 该连接 ready → Remote Host spawn Agent env → Agent 私有模型鉴权 → Provider 请求
  → 断线/关闭：停 Agent、清内存；不向另一连接复用 Key
```

临时安装以连接代际为幂等/过期边界；旧代际迟到响应不能发布 ready，也不能覆盖新 Key。配置同步的 `syncId` 只证明磁盘事务完成，不证明进程内 Key 仍存在；重连和远端进程重启必须重新安装。保存/同步失败时保持可诊断的旧事实或明确不可用，绝不把半提交状态报告成功。
每次临时安装都带本地 Personal Config 的内容指纹，目标在装入内存前对照自己的正式配置；两端版本不一致时拒绝，即使变量名恰好相同也不能把新 Key 装进旧配置。

## 验收

1. 旧配置无需迁移即可继续直写；临时模式本机保存后重新打开只显示「已配置」，本地模型请求用正确 Key，配置文件及 UI 事件没有明文。
2. SSH、WSL、Docker 首连、第二窗口与连接复用都在临时 Key 安装后才可发送；远端 `provider_config.json`、`credentials.json`、Provisioning 状态文件和日志不含该 Key，Provider 请求使用对应连接的值。
3. 缺失/损坏凭据、旧 Target、安装失败、配置与凭据版本不一致均在请求前失败；不偷偷使用远端旧值、不把本地 Registry 当远端事实。重连恢复时重新安装，而非依赖磁盘幂等命中。
4. Bash/MCP/插件读取环境不能拿到该变量；Key 不出现在命令行、工具输出、任务历史、错误日志。运行中修改须确认中断，取消不写；断网不离线续跑。
5. 已经存在的远端明文配置切换成功后被新配置替换；旧 Key 的历史泄漏不能由该功能保证消除，用户应轮换。Server remote 保持既有开发门禁且不提供临时模式。

安全边界：此能力只避免 Codez 主动把临时 Key 持久化到共享远端。远端进程运行期间，同一 OS 账户仍可能访问进程或滥用模型额度；环境变量不是按人授权，也不保证操作系统交换区、崩溃转储等外部机制绝不写盘。
