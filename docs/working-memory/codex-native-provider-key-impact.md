# Impact Brief：Codex 原生供应商临时 Key

## Feature Summary

| Field            | Value                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 让当前默认 Codex 桌面版自定义供应商 Key 仅在本机保存，并按连接临时送达远端                                                                      |
| Capability       | Codex `model_providers.<id>.env_key` 的 App 管理来源                                                                                            |
| Change layer     | presentation、validation、commit-effect、persistence、recovery                                                                                  |
| Operating mode   | implementation-handoff                                                                                                                          |
| Primary seeds    | `CodexProvidersPanel`、`codexProviderSettings`、`useCodexSettings`、`createLocalServices.resolveSpawnEnv`、`RemoteProviderProvisioningExecutor` |
| Out of scope     | ChatGPT/API 登录、手工外部 env/auth、Server remote、legacy Provider 行为                                                                        |

## UI Surface Matrix

| User scenario              | UI entry                          | Shared implementation                             | Display/draft owner        | Default/inherit source | Validation/gating                       | Commit action             | Authority/persistence                        | Mode boundary            | Must remain isolated from            |
| -------------------------- | --------------------------------- | ------------------------------------------------- | -------------------------- | ---------------------- | --------------------------------------- | ------------------------- | -------------------------------------------- | ------------------------ | ------------------------------------ |
| 本地自定义 Provider 配 Key | Settings → Codex → Providers      | `CodexProviderFormView` / `codexProviderSettings` | 表单草稿、投影仅是否配置   | `config/read` 用户层   | 自定义 id、base_url、鉴权互斥、确认中断 | Host 保存命令             | Local Credential Store + Codex `config.toml` | desktop local            | ChatGPT 登录、legacy Personal Config |
| 远端自定义 Provider 配 Key | 相同面板、active remote workspace | 同一表单，remote `useWorkspaceServicesResolution` | 同一 workspace-scoped 草稿 | 远端 Codex 用户配置    | 目标身份、连接 ready、版本与凭据匹配    | Window Host 复合保存/安装 | 本机 Key + 远端引用/内存                     | SSH/WSL/Docker，第二窗口 | Server remote、其他 target/workspace |
| 手机使用已连接任务         | 手机 remote attachment            | 现有任务/会话桥                                   | 手机仅恢复投影             | 已连接 Desktop Host    | Host lease                              | 不直接编辑 Key            | 同一 Agent owner                             | replayable               | 独立 Agent/Key owner                 |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                   | Deliberately different                    | Why it matters                              |
| -------------------- | ---------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| UI/component         | 原生 Codex Provider 表单                 | legacy `ModelProviderSection` 不复用      | 配置源分别是 TOML 和 Personal Provider JSON |
| Option source        | `config/read` 模型供应商                 | local/remote 分别从当前 Environment 读取  | 不把本机 Provider Registry 冒充远端事实     |
| Default/inheritance  | 旧条目直写默认                           | 手工外部 env 不自动成为 App 管理模式      | 避免无凭据引用的假「已配置」                |
| Validation           | `requires_openai_auth` 与 `env_key` 互斥 | 远端还需目标身份/安装校验                 | Codex 原生忽略冲突 env_key                  |
| Commit effect        | config/batchWrite 用户层                 | Key 保存在桌面 Local Host；远端逐连接安装 | Main/Renderer 不应持久化 Secret             |
| Persistence/recovery | 重启重新读取配置与凭据                   | 远端进程重启必须重装内存值                | 磁盘配置版本不证明 Key 已安装               |

## Feature Relationships

| Rank           | From                  | Semantic edge           | To                                   | Condition                  | Why inspect it                  | Evidence                                    |
| -------------- | --------------------- | ----------------------- | ------------------------------------ | -------------------------- | ------------------------------- | ------------------------------------------- |
| must-inspect   | 原生 Provider 表单    | commits-to              | Codex config/batchWrite              | 本地或远端当前 Environment | 只有引用可写入临时模式配置      | `CodexProvidersPanel.tsx`                   |
| must-inspect   | 本机 Credential Store | injects-at-spawn        | Codex bridge/app-server              | 仅 App 管理的 env_key      | 缺值必须在请求前失败            | `node.ts`、`codezAgentProcessManager.ts`    |
| must-inspect   | Window Host           | installs-per-connection | Remote Host                          | SSH/WSL/Docker             | 第二窗口与重连不能借用磁盘幂等  | `remoteProviderProvisioningService.ts`      |
| should-inspect | Provider 改动         | interrupts              | Active Codex runtime                 | Key 变更                   | 配置热刷新不更新进程环境        | `codezAgentService.ts`                      |
| invariant-only | Remote Host           | must-not-change         | desktop continuous/mobile replayable | 所有连接                   | 会话投递/owner/lease 不重新定义 | `docs/conversation-protocol-declaration.md` |

## State Owners And Commit Sinks

| State/fact   | Draft/display owner | Authoritative owner | Commit command/service     | Persistence/cache          | Evidence                   |
| ------------ | ------------------- | ------------------- | -------------------------- | -------------------------- | -------------------------- |
| Key 来源     | Provider 表单       | Codex 用户配置      | 带版本的 config/batchWrite | config.toml                | `codexProviderSettings.ts` |
| Key 值       | 仅当前输入草稿      | Desktop Local Host  | 本机凭据保存命令           | encrypted credentials.json | `credentialService.ts`     |
| 远端安装代际 | 无 UI 副本          | 各 Remote Host      | Window Host 安装 RPC       | 进程内存                   | `desktopRemoteSessions.ts` |
| 会话运行     | Codex projection    | Agent/Host          | runtime disposal/restart   | 既有会话事实               | `codezAgentService.ts`     |

## Must-Preserve Invariants

| Invariant                                         | Surfaces/modes | Proof needed            | Evidence             |
| ------------------------------------------------- | -------------- | ----------------------- | -------------------- |
| 不在远端 Codez 管理的文件/日志主动落 Key          | SSH/WSL/Docker | 请求鉴权 + 远端文件断言 | pending real SSH E2E |
| 旧直写、外部 env/auth、Server remote 不被暗中覆盖 | Codex/legacy   | 配置差分与失败用例      | focused tests        |
| 每条连接独立安装，断线不离线续跑                  | Desktop/mobile | 多窗口/重连/owner 测试  | Host integration     |

## Codegraph Evidence

| Seed                                 | Query                               | Direct callers / key path                                                      | Depth | Interpretation          |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------ | ----- | ----------------------- |
| `CodexProvidersPanel`                | codegraph unavailable; precise `rg` | `CodexSettingsSection` → `useCodexSettings` → scoped Agent service             | 2     | 默认桌面真实 UI         |
| `resolveSpawnEnv`                    | codegraph unavailable; precise `rg` | `createLocalServices` → `CodezAgentProcessManager` → bridge → Codex app-server | 2     | Key 注入唯一 spawn 边界 |
| `RemoteProviderProvisioningExecutor` | codegraph unavailable; precise `rg` | Window Host → Main ready barrier → Remote Target                               | 2     | 逐连接安装路径          |

## Graph Drift Candidates

| Candidate              | Live-code evidence                                               | Missing/stale graph relation                  | Proposed follow-up                                    |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| 原生 Codex Provider UI | `isCodexSettingsSection("modelProvider")`、`CodexProvidersPanel` | 现有临时 Key capability 明确排除 Codex-native | 增加独立 capability/surface，不把 legacy 边改写为原生 |

## Graph Delta

| Status    | Node/edge                                                                          | Semantic reason               | Evidence                 | Action             |
| --------- | ---------------------------------------------------------------------------------- | ----------------------------- | ------------------------ | ------------------ |
| confirmed | native Codex Provider key capability → Codex settings/Local credential/Remote Host | 用户确认支持当前默认 Codex 版 | 本次用户确认 + 原生 spec | planning：更新图谱 |

## Unresolved Questions

| Question | Candidate answers                                                                                                               | Scope difference                                              | Owner     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| none     | 用户已确认缺本机 Key 时可连接进入设置页，模型请求必须拒绝；多窗口以跨连接 admission 屏障 + ACK 收口，失败连接保持不可发送或断开 | 实现须覆盖保存、连接并发与 Host 退出，不复用无 ACK 的单向通知 | confirmed |

## Planning Handoff

| Item             | Destination                                                                           | Status     |
| ---------------- | ------------------------------------------------------------------------------------- | ---------- |
| Spec update      | `specs/codex-provider-runtime-env-key.md`、`specs/codex-model-provider-management.md` | complete   |
| Case catalog     | `docs/model-provider-regression-case-catalog.md`                                      | complete   |
| Coverage matrix  | `docs/testing/conversation-session-e2e-coverage-matrix.md`                            | complete   |
| Decision backlog | 无未定义的产品选择                                                                    | not-needed |
| E2E handoff      | 默认 Codex 本地 + real SSH pending                                                    | planned    |

## Clarification Log / Boundaries / Pruning

用户确认当前默认 Codex 版为目标；原有 legacy 模式保持独立。另确认远端缺本机 Key 时连接可进入设置页、模型请求在安装前拒绝。行为维度为来源（直写/本机管理/外部 env/auth）、位置（local/SSH/WSL/Docker/Server）、时序（初次/多窗口/轮换/断线）与证据（配置/凭据/请求/会话）。ChatGPT 账号、外部 env/auth 与 Server remote 按互斥鉴权和所有权剪枝；WSL/Docker 用服务集成测试对称覆盖，真实 SSH 为代表 E2E。接受的场景与 setup/action/assertion 见 `F-CODEXENV-001`–`005`，未审场景保持 planned，不将现有 legacy SSH 用例当作原生覆盖。
