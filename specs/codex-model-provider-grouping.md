# Codex 模型按 catalog provider 分组与跨 provider 切换

Status: 实现于 2026-09-29。修复 `model_providers` 配置了多个供应商时，GUI 模型
选择器与 Bot /model 只显示当前激活 provider（`config.model_provider`）一个分组
的问题。

## 问题与根因

Codex 原生 `model/list` 响应的 v2 `Model` 不携带 provider 字段（catalog JSON
里的 per-model `provider` 在 `ModelInfo → ModelPreset → v2 Model` 转换链中丢失）。
ZCode 因此把全部模型挂在激活 provider 名下：

- GUI composer 模型下拉是单一 provider 的扁平列表；
- Bot /model 第一级供应商列表只有 1 项；
- 用户无法辨认模型由哪个 provider 服务端点承接。

执行层早已支持多 provider：codex core `turn_context.with_model` 按 catalog 的
per-model `provider` 路由到对应 `model_providers` 条目，跨 provider 换模型不需要
重启或新线程（0.157.1 实测：`thread/settings/update` 换到另一 provider 的模型被
接受，thread 报告的 provider 保持创建期值不变——codex 的 thread provider 是
创建期固定身份，不随 catalog 路由更新）。

## 事实源与所有权

```text
config/read ──→ model_providers（供应商定义）+ model_catalog_json（目录文件路径）
model/list  ──→ 可见模型清单（无 provider 归属）
catalog/read ──→ 新增 bridge 控制面方法：host 本地读 catalog 文件，
                 产出 slug→provider 映射（多 provider 事实的唯一来源）
```

- model→provider 映射只存在于 `model_catalog_json` 文件中（codex 远端 catalog
  从不设置该字段），因此映射读取是 bridge 本地 fs 控制面方法，与 agents/\*
  同族：绝不能进入 `codex/request` 原生白名单。
- `catalog/read` 内部先经 `config/read` 取 `model_catalog_json` 解析后路径
  （含 profile/托管层合并结果），不接受调用方传路径——bridge 以用户权限运行，
  不开放任意路径读取面。
- 未配置 `model_catalog_json` → 返回空映射，全部模型归入激活 provider 组
  （与修复前行为一致）。文件存在但读取/解析失败 → ControlError 诚实报错，
  消费方（services/UI）捕获后降级为空映射并 warn，不阻断模型列表。

## 合同

- 新方法 `catalog/read`（`codezProtocolMethods.catalogRead`）：
  `{ path: string | null, models: [{ slug, provider? }] }`。只收录 catalog 中
  显式声明了 provider 的条目；`path` 为 null 表示未配置目录文件。
- `CodexHostModelCatalog`（services）与 `CodexModelCatalog`（UI）增加
  `groups: [{ providerId, providerName, models }]`：
  - 模型按映射归组；无映射条目归入激活 provider 组；
  - 组顺序 = 激活 provider 组优先，其余按目录中首现顺序；
  - providerName 取 `model_providers.<id>.name`，缺省回退 id；
  - 显式配置但不在目录中的模型（configuredSelection）归入激活 provider 组。
- `ModelSelectionView.providers` 按组展开为多 provider 视图；`providerId` 语义
  从「codex 配置 provider」变为「模型实际归属的 catalog provider」。
- 目录内模型的 `preferredSelection`（显式配置模型或目录默认模型）必须使用
  `catalog/read` 的实际 provider；无映射才回退配置 provider。模型和推理档位
  仍遵循配置优先规则。否则新任务会显示正确模型/档位，却因选择不属于任何组
  而禁用发送；切换模型后才偶然恢复。
- 选择解析（`resolveCodexEffectiveModelSelection` / UI `resolveCodexSelection`）：
  先在 providerId 对应组内精确匹配模型；provider 是已知组或当前配置 provider
  （即使其全部模型已映射到别组、没有独立分组）但组内未命中时，跨组
  唯一匹配则治愈为该组（兼容修复前存储的「激活 provider + 其他组模型」旧值）；
  完全陌生的 provider（legacy/其他 Host 残留）不猜归属，维持既有
  provider-not-found（services）/ 迁移到 preferredSelection（UI 草稿）口径；
  跨组歧义（同 slug 多组）或无匹配时维持 provider-not-found / model-not-found。

## 线程 provider 语义（bridge）

- `thread/start` 创建线程时把 selection.providerId 作为 `modelProvider` 透传，
  codex 线程身份与首发模型的 catalog provider 一致。
- 既有线程跨 provider 换模型不再报
  「changing provider on an existing thread」：codex 原生支持（执行按 catalog
  路由），bridge 守卫从「拒绝 provider 变化」放宽为「跟随最近一次选择的
  provider 更新线程记录」。
- `thread/settings/updated` 原生通知里的 `modelProvider` 是创建期固定值
  （codex 不提供运行期变更通道），不再覆盖 bridge 的选择派生记录；模型/档位等
  其他字段同步不变。
- 修复前创建的线程（modelProvider=当时的配置 provider）在下次携带选择的发送/
  换模型时自愈；resume/历史读取仍报告 codex 创建期值，属可接受的展示偏差。
- queue/steer 的 `assertUnchangedInputSettings` 守卫不变：per-input 换模型
  （含跨 provider）依然拒绝——原生 turn/steer 不接受模型参数。

## 失败语义

- catalog/read 失败（RPC/文件/解析）：消费方降级为空映射 → 单 provider 组，
  与修复前一致；不阻断 config/read + model/list 主链路。
- 映射中 slug 与 model/list 不重合（文件编辑后 codex 未重启等）：未命中模型
  归入激活 provider 组，不报错。
- 映射指向 `model_providers` 中不存在的 provider id：仍按映射分组显示
  （codex 执行时会 warn 并回退配置 provider，与 TUI 行为一致）。

## 迁移边界

- 无 `model_catalog_json` 的部署（含 ChatGPT 登录远端目录）：单 provider 组，
  行为与修复前完全一致。
- legacy Provider Registry 路径不经过本分组逻辑，行为不变。
- Bot 存储的旧选择值经跨组治愈逻辑兼容，不做数据迁移。
- Composer 草稿继续由 `useDraftConfigControl` 持有原意图，展示与提交通过现有
  resolver 派生完整选择；恢复仅修正 provider，保留模型、显式 `high` 等档位、
  正文、权限档位与 plan。不增加同步 effect、超时重试、配置写入或第二套状态。
  不主动修改已运行线程；提交与忙碌输入的校验保持不变。

```text
Host config / model / catalog 事实
          ↓ 按目录归属生成 preferredSelection
Composer 草稿 owner（新任务默认 / 已存储选择）
          ↓ resolver 唯一匹配修正 provider，保留模型和档位
完整选择投影 → 严格提交校验 → 既有 Host command admission
```

上述恢复是工作区内的选择解析，不改变 workspaceIdentity 隔离、owner/lease、
desktop continuous 或 mobile replayable 的传输与恢复语义。

## GUI 验证夹具与验收

- 隔离交互夹具的 `codezAgentService` 必须实现真实 composer 调用的
  `readCodexCatalog` 服务边界；模型归属映射由夹具返回，不通过旧 Provider
  Registry 或伪造的原生 `model/list` provider 字段取得。目录读取属于可选
  增强；失败时真实 hook 退化到单激活 provider 组，不阻断发送。
- 夹具中工作区和配置的事实所有者仍是注入的 Host 服务；UI 只保留当前
  workspace 的目录投影，切换工作区和配置失效后重新读取。交互测试至少
  验证新任务首发可用、原生目录读取发生且旧 Registry 读取为零，再继续验证
  原有的发送、切换、提问、权限及设置场景。
- 验证顺序：配置/目录/模型读取 → 草稿就绪 → 发送 → 命令投影；
  目录辅助读取失败只触发已定义降级。测试只使用隔离的模拟 Host，
  不写入用户 Codex 配置或凭据；这不能替代真实 Electron/Host 验证。
- 回归场景：配置 provider 不拥有任何可见模型时，冷启动 GLM-5.3/high
  新任务无需手动切模即可按钮发送和 Enter 发送；已有「配置 provider + 非默认
  目录模型 + high」草稿修正归属但不重置模型/档位/权限/正文；刷新后仍可用。
  Shift+Enter 仍换行；陌生 provider 维持原有迁移/拒绝规则、不猜归属；
  跨组同名歧义、模型移除、非法档位仍阻断。
