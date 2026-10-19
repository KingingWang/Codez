# Codex 原生自定义供应商的本机临时 Key

Status: 已实现（真实 SSH/WSL/Docker 整链路验收待跑）。承接 `specs/provider-runtime-env-api-key.md` 的「远端 Codez 不主动持久化 Key」目标，但使用 Codex 原生 `model_providers.<id>.env_key`，不复用 legacy Personal Provider Config。

## 范围与安全边界

- 只覆盖桌面版 Codex 的自定义 `model_providers`。ChatGPT/内置 OpenAI 登录、账号型 Provider、手工配置的外部 `env_key` / `[auth]`、开发模式 Server remote 不自动迁移或代管。
- GUI 提供「写入配置文件」和「本机保存、临时环境变量」两种 Key 来源。旧条目保持 `experimental_bearer_token` 直写语义；选临时模式时，App 为目标 Environment + Provider 生成专用变量名，将用户输入或明确迁入的原有明文 Key 保存到桌面 Local Host 的 Codez Credential Store。原生用户层 `config.toml` 只留 `env_key`，移除 `experimental_bearer_token`，不得同时设置 `requires_openai_auth=true` 或 `[auth]`。
- 本地 workspace 的 Local Host 在 Codex bridge/app-server 启动前现读本机凭据并仅注入该原生 Provider 需要的变量。SSH/WSL/Docker 的 Window Host 以目标 Environment 为身份读取同一台桌面上的凭据，经现有可信远程 RPC 向**每条在线连接**的 Remote Host 内存安装；远端 Codex bridge/app-server 重新启动后继承变量。远端配置文件、Codez Credential Store、Provisioning 信封/状态、shell 命令行、Renderer/Main 日志与会话快照不保存值。
- Desktop Renderer 合并 SSH/WSL/Docker workspace 服务时，`codexNativeProviderKeyService` 必须来自该连接的 Window Host remote workspace collection，而不是本机 base services；`codezAgentService` 同样指向该远端连接。Key 服务虽然在桌面端保存凭据，其环境分区仍是目标 `buildRemoteEnvironmentKey(target)`。本机 workspace 继续使用 local 分区，Server remote 继续由服务端负责，不从本机透传托管 Key。远端断开/换代时不得回退本机 Key 服务。
- 原生 `env_key` 的值进入 Codex app-server 的进程环境。无法承诺共享 OS 账户的其他进程、Codex 自己的工具/MCP 子进程或系统转储绝对无法读到；这不是按人隔离，只降低 Codez 主动远端落盘。UI 必须明确说明，不能沿用 legacy Agent 的工具环境隔离验收结论。
- Codex 自身的 `config/read` 会读取用户层原有明文 Key；UI 只投影是否已配置，绝不回显。已在旧配置/备份中出现的 Key 应由用户轮换。手工外部 `env_key` 不得被当作 App 凭据已配置或默默改写。
- Codex profile 文件（`$CODEX_HOME/<profile>.config.toml`）不在托管范围：远端安装只按目标机默认 `config.toml` 校验引用。极端的 profile 用户会表现为安装后仍缺值并 fail-closed，不做隐式猜测。

## 单一所有者与接口

| 事实                              | Owner                                                                                | 读取/写入路径                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 原生 Provider 字段与 Key 来源引用 | 当前 Environment 的 Codex `config.toml`                                              | Codex `config/read`、带 `expectedVersion` 的 `config/batchWrite` |
| Key 明文                          | 桌面 Local Host Credential Store；按 local 或远端 Environment key + Provider id 隔离 | Host 私有保存命令；Renderer 仅传本次用户输入，Main 不持值        |
| 每连接安装事实                    | 对应 Remote Host 进程内存                                                            | Window Host 可信 RPC，连接/代际屏障；断线清空                    |
| Agent 环境与活动线程              | 当前 workspace 的 Codez Agent Service/Codex bridge                                   | spawn env、明确中断/重启；旧代际结果不发布 ready                 |

```text
设置页草稿 → 所属 Window Host 的单一保存命令
           ├─ 本机 Credential Store（失败须恢复旧值）
           └─ 当前 Environment Codex config/batchWrite（只写引用）
                → 本地 Agent / 每条远端连接停止旧运行时
                → Local Host 现读 / Window Host 逐连接安装
                → 新 Codex bridge/app-server spawn env → Codex 按 env_key 鉴权

远端首连/重连 → 读目标 Codex 用户配置 → 找到 App 管理的引用
             → 读本机目标身份对应凭据
             ├─ 值齐全：远端内存安装 → ready（可发送）
             └─ 缺值：ready（仅设置可编辑）→ 模型请求在 bridge 准入前拒绝
```

保存过程中不能让旧 Key 的 Agent 接受新输入。取消确认零写入；写入、安装或版本校验失败时保留可诊断旧事实或明确不可用，不把半提交报告成功。运行中换 Key 须提示会中断进行中任务；原生配置热刷新不足以更新进程环境，因此必须重启受影响的 Agent。多窗口同一远端 Environment 的配置版本与临时安装分别协调，连接重启即使文件版本未变也必须重装。手机只复用桌面 Host attachment，desktop continuous / mobile replayable 的会话投递及 `workspaceIdentity?.trim() || workspacePath` 不改。意外断线不继续离线执行。

## 连接准入与轮换边界

用户已确认：远端 `config.toml` 引用 App 托管 `env_key` 但本机缺凭据时，连接仍进入可编辑设置页；模型请求在发到供应商前拒绝，不能回退旧明文或继承同名变量。Settings 所需 `config/read` 与目录读取应可使用，不能用阻止整个 Agent 启动代替模型请求门禁。补录并安装成功后重启 Agent，解除该连接的模型阻断。

多窗口轮换的事务不等同于现有 `ProviderProvisioningSourceChanged` 单向通知。目标 Environment 需要串行的跨连接屏障：

```text
Window Host 保存命令 → Main 获取 Environment 代际/锁
  → 所有在线 Remote Host 进入拒绝新模型输入状态并停止旧 Agent（逐连接 ACK）
  → 来源 Host 备份旧凭据并保存新值 → Codex config/batchWrite(expectedVersion)
  → Main 要求每条连接按最新引用和本机值安装；远端验证引用/版本，重启 Agent（逐连接 ACK）
  → Main 释放屏障；失败连接保持拒绝/断开，不凭磁盘 already-applied 跳过安装
```

来源 Host 异常退出、配置 CAS 失败或安装失败时，不以旧 Key 自动恢复运行；确认后已接受的任务沿既有中断结算，不自动重放。新连接在该 Environment 屏障完成前不得发布可发送状态。desktop continuous 和 mobile replayable 只沿用各自的既有会话投递，不新建手机 Agent。

## 验收

1. 原生供应商在默认 Codex GUI 的「模型供应商」面板可选择 Key 来源；配置文件模式兼容旧数据。临时模式保存后 `config.toml` 只有 `env_key`，本机 Credential Store 有值，重开显示已配置但不回显。
2. 本地 Codex 实际模型请求使用该值；缺凭据、冲突鉴权方式、无效配置在网络请求前失败，不回退旧明文或外部同名变量。
3. SSH/WSL/Docker 首连、第二窗口、重连在各自安装成功后才能使用；远端原生配置及 Codez 管理的凭据/状态/日志无 Key。某连接退出不清另一连接的内存值。
   - 回归场景：在已连接 SSH workspace 的设置页首次选择「本机保存」并输入 Key，保存后检查桌面注册表只有目标 SSH 环境分区新增该供应商、local 分区不新增；远端配置只有 `env_key`。重连并实际发送模型请求，确认 Key 由目标连接安装并注入运行时；断连期间设置页不得将保存请求转给 local 服务。
4. 运行中更换/清除或切换模式先确认，再中断旧 Agent，随后以新配置重新启动；取消不写。失败不继续使用旧环境作为隐式兜底。
5. Server remote、ChatGPT 登录、手工 `env_key`、legacy Provider 维持原行为；旧明文历史不可保证清除，提示轮换。共享远端 OS 账户在运行时仍可能使用 Key。

## 依据

- [OpenAI Docs — Authentication](https://developers.openai.com/codex/auth)：自定义 Provider 的 `env_key` 从环境变量读取；`requires_openai_auth` 会忽略 `env_key`。
- [OpenAI Docs — Configuration Reference](https://developers.openai.com/codex/config-reference)：`experimental_bearer_token` 是不推荐的直写字段，`env_key` 是供应商鉴权变量名。
