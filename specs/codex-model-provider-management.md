# Codex 模型供应商与目录模型的 GUI 管理

Status: 已实现；2026-11-01 收口原设置布局。设置 → Codex 的「模型供应商」面板直接管理 config.toml 的
`model_providers` 与 `model_catalog_json` 目录文件中的模型条目，不再只能手编
TOML/JSON。分组显示与跨 provider 路由的事实源契约见
specs/codex-model-provider-grouping.md，本 spec 只定义管理（写）路径。

## 产品规则

- 面板复用 fork 前模型配置页的左右分栏：左侧选择供应商，右侧显示该供应商的
  配置与目录模型。新增供应商、刷新仍位于共享设置页头部。只恢复展示与操作
  布局，不接回旧 Provider Registry 的配置、鉴权或模型写入路径。
- 窄屏保留左侧导航与右侧同一配置目标；供应商操作另起一行，模型操作在说明
  下方换行，不能把名称/地址区域挤成逐字纵排。390px、中英文与明暗都检查实际文字宽度。
- 2026-11-02 实际组件浏览器验收：供应商切换、单模型删除保护、可见性、原地改名、
  重启确认与 390/1280px × 中英文 × Zai 明暗通过，工件
  `/tmp/codex-ui-provider-model-slug-rEpxvf`。布局/切换未产生配置写入；
  目录写入 2 次，其中原 slug 改名 1 次。浏览器假 Host 不替代真实 Key 存储或 SSH 验收。
- 2026-11-19 常驻重启入口回归：实际组件定向验收 14 项及八种布局/确认态通过，
  工件 `/tmp/codex-ui-provider-model-slug-dCKqaT`；完整交互回归 60 项、零页面异常，
  工件 `/tmp/codex-ui-interaction-e2e-cfKCmw`。覆盖面板卸载、identity 隔离、
  保存/重启在途禁用、取消、dispose 失败与重读失败；Host IO 为隔离夹具。
- 右侧分两个区块：**供应商**（`model_providers` 表）与**模型**（catalog 文件
  条目）。模型按 catalog provider 筛选，与 composer 下拉同一归属口径；
  没有已配置供应商的目录组仍可通过左侧独立入口查看，不因布局改变隐藏历史条目。
- 供应商选择只归面板本地 UI；不能写 `config.model_provider` 或改变会话模型。
  切换供应商关闭尚未提交的供应商/模型表单，切换 workspace/service/identity
  沿用外层 formKey 清理，不能带着旧目标草稿写入新目标。
- 供应商字段（MVP）：id、name、base_url、wire_api（chat/responses/anthropic/gemini）、
  API Key（`experimental_bearer_token`）、requires_openai_auth。id 创建后不可改
  （TOML 表键即身份；改名 = 新建 + 删除）。
- `gemini` 只扩展 GUI 对上游 `wire_api="gemini"` 配置的读取、选择与写回；
  不新增内置供应商或模型模板，也不修改 pinned Codex runtime。能否实际执行
  Gemini 请求由当前 runtime 的协议支持决定；上游支持尚未进入当前 pinned
  版本时，允许提前管理配置不代表该协议已经可运行。
- 配置文件来源的 API Key 明文写入 config.toml（codex 原生
  `experimental_bearer_token` 字段，RedactedString 日志打码）。本机临时来源由
  Codez Credential Store 持值，Codex `env_key` 仅存引用；App 在 Agent spawn
  时定向注入，不依赖 Finder/终端继承环境。完整边界与验收见
  [codex-provider-runtime-env-key.md](./codex-provider-runtime-env-key.md)。
  **UI 只写不回显**：config/read 会返回原有明文，
  面板只呈现「已配置」状态；输入新值才覆盖，留空 = 不修改；提供「清除」
  （写 null 删键）。
- 模型字段（MVP）：slug、provider（下拉，限已有供应商）、display_name、
  description、visibility（原生枚举 `list/hide/none`；`hide` 不出现在 model/list
  默认视图但保留配置，`none` 保持原生语义）。GUI「隐藏」草稿只是布尔值，
  不能把 UI 字段名 `hidden` 当作原生枚举写入文件。其余能力字段（context_window、reasoning levels 等约 30 个）经
  **单模型高级 JSON 编辑器**维护：编辑表单内折叠区直接编辑该条目的完整
  JSON；新增模型时从同 provider 现有首条模型复制能力模板，只允许先改
  slug/display_name/description/provider。Codex 原生 `ModelInfo` schema 要求
  `display_name` 与 `description` 为必填字符串字段（缺失会导致重启时解析
  `model_catalog_json` 失败）：因此 `display_name` 未填时默认回退为
  `description`（若也没填则回退为 `slug`），`description` 未填时自动补充为
  最终的 `display_name`，bridge `catalog/writeModel` 同样兜底补齐这两个字段，
  绝不写出缺失 `display_name` 或 `description` 的目录条目。编辑已有模型时 slug 允许修改，用于
  供应商模型版本升级后的原地替换；改名是 `catalog/writeModel` 的单次原子
  目录写入（传 `originalSlug`），不是 GUI 串联“新增 + 删除”。若旧 slug 是
  `config.model`，沿用删除默认模型的既有语义：显示警告并允许保存，新线程
  回退到 provider 偏好模型；GUI 不得暗中改写全局默认模型。
- 操作约束：
  - 供应商 id 仅允许 `[A-Za-z0-9_-]+`（config/batchWrite keyPath 按 `.` 分段，
    id 含点会破坏路径语义；TOML 裸键同口径）。
  - 供应商 base_url 必须是绝对 `http://` / `https://` URL（含 host），与 codex 原生
    `url::Url::parse` 的运行时解析口径一致；表单在写入 config.toml 前拒绝非法值
    （错误键 `providerBaseUrlInvalid`），避免把原生请求期才会失败的坏配置落盘。
  - 删除供应商：当前默认供应商（`config.model_provider`）禁止删除；仍有
    catalog 模型引用时给出明确提示，由用户先迁移/删除模型，不静默级联。
    catalog 正在读取、读取失败或尚未验证引用关系时，所有供应商的删除入口
    必须 fail-closed（禁用按钮和命令入口）。目录成功读取为无配置（path=null）
    时才可把引用数视为 0；不能用失败时的空数组假装已证明不存在引用。
    两个入口必须共用同一判定来源（`codexProviderDeleteBlock`）：按钮禁用只
    负责呈现，写入前判定负责不变量；删除写入不得只依赖渲染期 prop，否则新增
    入口、快捷键或自动化调用会绕过 fail-closed。
    目录读取失败时引用数显示“未知”而不是 0，并只显示读取错误，不能额外
    宣告 `model_catalog_json` 未配置；只有成功返回 `path=null` 才显示未配置。
  - 删除模型：slug 等于 `config.model`（新线程默认模型）时给出警告但允许，
    但**禁止删除已配置目录的最后一个模型**。Codex 原生加载
    `model_catalog_json` 时拒绝 `{ "models": [] }`；GUI 须禁用该按钮并解释
    应先新增替代模型。bridge 在读取当前文件后、写入前独立拒绝最后一条
    的删除，直连控制面和过期 GUI 读数都不能写坏目录；失败不改写文件、
    不声明重启待办。未配置目录与不存在的 slug 保持原有失败语义。
  - 「设为默认供应商」写 `config.model_provider`；codex 的
    check_thread_model_provider 只校验托管要求，用户层变更不会 invalidate
    现有线程路由（0.157.1 源码核实）。

## 事实源与所有权

### 首次启动缺失配置文件与模型目录文件的自动初始化

- 新安装环境中 `$CODEX_HOME/config.toml`（缺省 `~/.codex/config.toml`）与
  `model_catalog_json` 模型目录文件可能尚不存在。若缺少这两个文件：
  - `config.toml` 未配置 `model_catalog_json` 时，`catalog/readModels` 返回
    `path: null`，GUI「模型供应商」面板无法管理目录模型；
  - 已配置 `model_catalog_json` 但指向的模型目录文件缺失或为空时，Codex
    `app-server` 在启动期加载 `model_catalog_json` 会直接报错退出。
- 因此，bridge 在拉起 `codex app-server` 之前执行幂等的首启默认文件补齐
  （`ensureDefaultCodexConfigFiles`）：
  1. 解析 `codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex")`，
     按需 `mkdir(codexHome, { recursive: true })`。
  2. 若 `${codexHome}/config.toml` 不存在：
     - 先确保 `${codexHome}/models.json` 存在（不覆盖已有文件），写入符合
       Codex 原生 `ModelsResponse` / `ModelInfo` schema 的推荐默认模型条目
       （含 `slug: "gpt-5.4"`、`provider: "openai-custom"`、完整能力字段与
       `base_instructions`），供后续 GUI 新增模型时通过
       `codexCatalogModelTemplate` 复制能力模板；
     - 以 `flag: "wx"` 创建默认 `${codexHome}/config.toml`，配置
       `model_provider = "openai-custom"`、`model = "gpt-5.4"`、
       `model_catalog_json = "models.json"` 及
       `[model_providers.openai-custom]`（注意：`openai` 为 Codex 原生保留
       provider id，自定义表必须使用非保留 id）。
  3. 若 `${codexHome}/config.toml` 已存在：
     - 绝不改写现有 `config.toml`；
     - 解析顶层 `model_catalog_json`（相对路径相对 `codexHome` 解析），若已配置
       但目标目录文件尚不存在，则按默认推荐模型目录自动创建该文件（绑定配置中的
       `model_provider` 与 `model`），避免 Codex 因目录文件缺失而无法启动。
  4. 原生进程启动前，检查上述用户配置引用的目录（含绝对、相对及 `~/` 路径）：
     仅把模型条目顶层的历史 `visibility: "hidden"` 迁移为 `"hide"`。
     迁移前在同目录保存唯一命名的 `.codez-catalog-*.bak` 原始字节备份，再原子写回；
     保留文件权限、符号链接目标、其他模型能力和目录顶层未知字段。
     已合法的文件不重写、不重复备份；非法 JSON、非法目录结构或其他未知枚举不猜测修复，
     保留原文件交给 Codex 报错。该迁移不扫描其他目录、不改 config.toml，也不宣称解决
     下述跨进程条件提交问题。托管/项目层覆盖的路径仍由原生配置与控制面解析，
     不新增本地配置层合并器。

```text
codex-bridge main 启动
  ──→ ensureDefaultCodexConfigFiles(env)
        ├─ config.toml 缺失 ──→ 补齐 models.json (wx) + 创建默认 config.toml (wx)
        └─ config.toml 已存在 ─→ 若 model_catalog_json 指向的文件缺失，补齐该目录文件 (wx)
  ──→ 引用目录 legacy hidden → 备份 → 原子迁移 hide（无变化则跳过）
  ──→ createCodexProcess (spawn codex app-server)
  ──→ GUI CodexProvidersPanel 可直接读取 user layer 与 catalog.path，新增/编辑供应商与模型
```

目录列表的可见性开关表达「在模型下拉中显示」（`checked = !hidden`），
不能在勾选时读作「隐藏」。可访问名称包含模型 slug，同名模型也必须有不同控件名。
编辑表单的独立「隐藏」开关仍表示布尔草稿（`checked = hidden`），保存写 `"hide"`；
已有 `"none"` 的隐藏条目在不改变可见性时保存仍保留 `"none"`。
读取兼容历史 `"hidden"`，同时正确展示原生 `"hide"` / `"none"` 为非列表可见。
列表切换沿用原有目录写入命令、权威重读和重启提示。验收：可见与隐藏模型的
勾选状态相反、读屏名称与状态一致且包含 slug；切换后向同一目录所有者写入
相反的可见性，表单草稿语义不变。

```text
config.toml model_providers ──config/batchWrite(reloadUserConfig: true)──→ 热刷新所有
                              已加载线程配置，新 turn 立即可路由（与记忆设置同机制）
model_catalog_json 文件     ──bridge catalog/* 本地控制面写──→ 原子写（tmp+rename）
                              → 随后 config/batchWrite 空 edits + reloadUserConfig
                              触发线程 Config.model_catalog 重读文件，新 turn 可路由
                              新 slug；model/list 下拉需重启 workspace runtime 刷新
```

- catalog 文件读写是 bridge 本地 fs 控制面方法族（与 agents/\*、catalog/read
  同族）：路径一律由 bridge 内部经 `config/read` 解析 `model_catalog_json`，
  不接受调用方传路径（不开放任意路径读写面），绝不进入 `codex/request`
  原生白名单。
- **未决跨进程写入边界**：`catalog/writeModel` / `catalog/deleteModel` 当前
  执行「读文件 → 修改内存列表 → 同目录临时文件 rename」。rename 只保证读者
  看不到半截 JSON，**不是**基于文件版本的条件提交。其他 Codex/编辑器进程
  在读取后、替换前改动目录时，本次写入可能覆盖其改动；若对方删了一个模型，
  本次写入甚至可能把它恢复。最后模型守卫只保证本次 bridge 不主动写出空目录，
  不保证多进程修改不丢失。需要先确定产品语义和唯一权威写入接口：采用可验证
  的原生条件写入，或停止提供不具备并发保证的 GUI 修改入口；不能把再次读取
  或定时重试称为原子修复。
- **codex 启动期快照限制**：配置了 `model_catalog_json` 时 codex 用
  StaticModelsManager 持有启动期目录快照，`model/list` 不随文件变更刷新
  （reloadUserConfig 只重载线程 Config）。因此目录写入后：
  新 turn 路由立即生效（线程 Config.model_catalog 已重读）；GUI 模型下拉
  （model/list 数据源）需重启 workspace runtime。面板顶部常驻「重启 app-server」
  动作，不以“本次打开面板是否修改过模型”为显示条件（codezAgentService.disposeWorkspace，
  中断该工作区在途任务，需用户确认）；确认时明确显示该中断风险和
  「确认重启」，不得沿用「确认移除」。不重启也不产生错误状态。
- 供应商写路径不需要重启：provider 定义在 turn 时从线程 Config 解析。

### 重启入口与待刷新提示

- 重启按钮属于当前工作区，不属于某个供应商；没有目录改动时仍可主动重启。
  保存中、读取中、重启中或工作区连接不可用时禁用。重启不要求存在可写 user config
  layer，也不要求目录读取成功，避免恢复入口反过来依赖要恢复的配置。
- 待刷新提示唯一归窗口内 `codexCatalogRestartStore`（Zustand）所有，只记录 GUI
  已成功写入目录的提醒，不复制原生模型目录、任务或运行时事实，不持久化到磁盘。
  作用域为 Agent service authority + `workspaceIdentity?.trim() || workspacePath`；
  同路径不同 identity/Host 不共享标记。切换供应商、设置分区、关闭再打开设置和
  配置重读不清除该标记。供应商配置保存不设置该标记。
- 写入成功立即登记一个新标记，再重读目录；重读失败不能掩盖已写入的待刷新事实。
  重启复用 `useCodexSettings.run` 的单一 mutation admission，确认后调用现有
  `disposeWorkspace`，再通过当前目标目录读取拉起新 runtime，显式失效 composer 目录。
  只有 dispose 和重读都成功才清除重启开始时捕获的标记；失败保留提示并展示错误。
  清除采用标记身份比较，旧请求不能清除其他目标或其后新写入的标记。
- Desktop 与手机 Web 均复用已有 workspace service/Host 路由，不新增 Agent、
  Host、协议或 stream/snapshot 链路；远程 identity 与 attachment 边界不变。

```text
目录写入 → Host/bridge 原子写成功 → 窗口 Zustand owner 登记目标标记 → 重读目录
切换设置 / 关闭设置 ─────────────→ 标记保留，重启按钮再次打开仍常驻
用户确认 → settings.run（单一锁）→ disposeWorkspace（现有 Host/runtime owner）
                                → 同目标读取拉起 app-server → 失效 composer 目录
                                → 成功：仅清除捕获标记；失败：保留标记 + 显示错误
```

## 合同

新增 bridge 控制面方法（`codezProtocolMethods`）：

- `catalog/readModels`：`{ path: string | null, models: unknown[] }`。
  返回目录文件中的完整原始条目（含全部能力字段），供管理表单与高级 JSON
  编辑器使用；未配置目录文件时 `path` 为 null、`models` 为空。
  每条目至少校验为带 string `slug` 的对象，否则整条目读取失败诚实报错。
- `catalog/writeModel`：`{ workspace, model: <完整条目 JSON>, originalSlug? }`。
  缺省 `originalSlug` 时按新 slug upsert：同 slug 替换整条，否则追加到 models
  末尾。编辑改名时传非空 `originalSlug`：必须命中一个旧条目并在其原位置整条
  替换；新 slug 与其他条目冲突、旧条目不存在时拒绝写入且文件字节不变。条目
  必须是带非空 string `slug` 的对象。原子写（同目录 tmp 文件 + rename）。
  `visibility` 可省略；提供时只接受 `list/hide/none`，历史 `hidden` 在协议边界
  归一为 `hide`。其他值（含 null/数字）拒绝且不落盘。列表开关、模型新增/编辑、
  高级 JSON 保存和直连控制面共用该校验。读目录同样归一历史值，因此任一目录写入
  都不能把其他条目的旧 `hidden` 再写回；读操作本身不改文件。
- `catalog/deleteModel`：`{ workspace, slug }`。按 slug 删除；不存在时报
  未找到错误（调用方据此提示，不当成功处理）；最后一条目录模型则拒绝，
  仍返回明确错误，文件原始字节不变。

三者结果均含 `{ path, models: [{ slug, provider? }] }`（与 catalog/read 同形），
写路径顺带返回最新映射，调用方无需二次读取。文件不存在时 writeModel 按
`{ models: [] }` 起始创建（父目录必须已存在，否则报错）；deleteModel/
readModels 按「未配置/空目录」语义处理：readModels 返回空，deleteModel 报未找到。

services 透传：`codezAgentService.readCodexCatalogModels / writeCodexCatalogModel /
deleteCodexCatalogModel`，载体铁律与 `readCodexCatalog` 相同（workspace carrier，
远程 workspace 由远端 bridge 读写远端文件）。

## UI 结构

- `CodexSettingsSection` 新增 `providers` 面板（nav「供应商」），由
  `CodexProvidersPanel` 承载；不在 isCodexUnsupportedSection 之列。
- 数据层 `codexProviderSettings.ts`：
  - `codexProvidersView(config)`：从 config/read 提取供应商表视图（id、name、
    base_url、wire_api、requires_openai_auth、hasBearerToken、是否默认、
    引用该供应商的模型数由调用方 join catalog 数据）。
  - 编辑构建器：创建 = 整表 replace（`model_providers.<id>` = 完整对象）；
    更新 = 逐字段 replace + 清空字段写 null（保留用户手编的未知 key，
    如 query_params/http_headers/chat_stream）；token 仅在输入新值时产生编辑。
- 目录模型列表经 `readCodexCatalogModels` 读取；slug→provider 分组显示与
  composer 下拉同口径。

## 验收场景

1. 添加供应商（含 API Key）→ config.toml 出现对应表，reloadUserConfig 后
   新线程可选用；面板刷新后显示「已配置 Key」而不显示明文。
2. 编辑供应商 base_url / 清除 Key → 对应键更新/消失，用户手编的未知键
   （chat_stream 等）保留。
3. 设为默认供应商 → `config.model_provider` 更新，现有线程不中断。
4. 删除默认供应商被拒绝；删除仍被模型引用的供应商给出提示。
5. 添加模型（复制同供应商模板，改 slug/display_name）→ catalog 文件原子更新；
   面板提示重启运行时刷新下拉；重启后 composer 下拉新模型出现在对应
   provider 组。
6. 模型高级 JSON 编辑：修改 context_window 后保存，文件 JSON 合法且其他
   条目不变；非法 JSON 不落盘并提示。
7. 列表关闭或表单隐藏保存写 `visibility: "hide"`；再开启写 `"list"`。
   原生重启后 `model/list(includeHidden=false)` 排除隐藏模型，`includeHidden=true`
   仍可读到条目，原生配置重载不产生 unknown variant 错误。
8. 远程 workspace：全部读写经远端 bridge 执行，本机不产生文件写。
9. 模型目录读取失败或尚在加载：非默认供应商的「删除」也不可操作，不向
   `config/batchWrite` 发删除 edit；重新打开面板成功读取后，引用数为零的
   非默认供应商恢复可删除，仍有引用的继续禁止删除并保留解释文案。
   失败页不显示虚构的 0 个引用或“未配置目录”。
10. 添加/编辑供应商时 base_url 填 `not-a-url` 或 `ftp://x` → 表单报
    `providerBaseUrlInvalid` 且不发起 config 写入；填 `http://127.0.0.1:34185/v1`
    通过校验并落盘。
11. 配置了单模型目录：GUI 显示「至少保留一个目录模型」，删除按钮禁用；
    绕过 GUI 直发 `catalog/deleteModel` 被 bridge 拒绝，原始 JSON 字节不变，
    不引入原生 Codex 的空目录加载错误。加第二模型后允许删第一条，仍保留一条。
    外部进程在 GUI 读取后删去其他模型时，以 bridge 写入前的最新读取为准。
12. 首次打开提供商页、尚未修改配置时即显示「重启 app-server」。
    成功保存目录模型后，待刷新提示在切换设置分区、关闭再打开设置后仍存在。
    同路径切换不同 identity 不串提示，返回原 identity 恢复其标记。
    点击重启先显示本工作区进行中任务将被中断和「确认重启」；
    取消不调用 disposeWorkspace、不清除提示，确认仅调用一次。
    重启失败保留提示与错误；成功清除提示但按钮仍可用，并可再次主动重启。
    保存和重启在途时按钮禁用；目录读取失败和缺少可写配置层不隐藏恢复入口。
13. 首次启动时 `$CODEX_HOME` 下无 `config.toml` 与模型目录文件：bridge 启动时自动创建
    默认 `config.toml` 与 `models.json`，Codex 原生进程正常解析启动，GUI「模型供应商」
    面板可正常读取默认供应商与模型并继续添加新供应商与模型；已有文件绝不被覆盖。
14. 添加或编辑 `gemini` 供应商：协议下拉提供 `gemini`，保存后 `wire_api` 原样写入
    `model_providers.<id>.wire_api`；重新读取时仍显示 `gemini`，不被归一化为 `chat`。
    其他协议及未知值回退行为保持不变。本场景只验证配置管理，不替代 runtime 的
    Gemini 请求、流式响应与工具调用验证。
15. 打开模型供应商页：出现与原模型配置页共用的左右分栏，左侧供应商选择、
    右侧配置及所属模型。选择另一供应商不发送任何写请求，不改默认供应商或
    会话模型；编辑/新增/删除/Key 保存继续通过既有 native port。以浏览器
    真实组件检查 390px 与 1280px、中英双语、明暗主题和键盘选择。
16. 目录有未配置供应商的模型：左侧仍提供该目录组入口，可编辑/删除这些模型；
    默认选择刷新后失效时回落到现有首个入口，不展示旧目标的编辑表单。
    Provider Key 轮换引起的同目标 runtime 重启不得关闭未成功保存的表单或
    将成功回包当成旧目标回包。
17. 编辑已为 `hide/none` 的模型（含高级 JSON、改 slug）时隐藏状态正确，保存不变成
    `hidden`；新增时复制隐藏模板也写合法枚举。直连 `catalog/writeModel` 传旧
    `hidden` 写成 `hide`，传未知枚举失败且文件字节不变；删除/更新其他模型不重新
    引入遗留值，目录顶层元数据保持不变。
18. 用户配置引用的自定义目录已有 `hidden`：启动先保留原始备份并迁移，随后原生
    app-server 正常初始化；再次启动目录字节不变且不产生新备份。分别验证绝对、
    相对路径以及链接目标；无旧值、非法 JSON 或未知枚举不被擅自改写。

### 2026-11-17 visibility 兼容修复证据

- `packages/codex-bridge/test/catalog-file.test.ts` 在 Linux 真实 Codex 0.163.0
  （仓库 pinned）和本机 0.165.0 均复现 `config/read` 拒绝 `hidden`；
  迁移后配置读取、`model/list`、目录写入后 reloadUserConfig 与重启通过。
  首次 `initialize` 握手完成不能单独证明目录可解析，不把报错归因于未核实的升级版本。
- `packages/ui/src/settings/codex/qa/provider-model-slug-e2e.mjs` 实际组件浏览器
  验收通过；8 项检查、5 次目录写入、1 次原 slug 改名，包含 `hide/none`、
  高级 JSON、隐藏模板新增、390/1280px × 中英文 × 明暗。工件
  `/tmp/codex-ui-provider-model-slug-llg96g`；假 Host 不替代真实远程连接或其他 OS 验收。

```text
GUI 已观察目录 → 展示禁用或确认 → bridge 接收 deleteModel
                                    → 读取当前文件 → 计算剩余模型数
                                    ├─ 0：拒绝，文件不变，GUI 不提示重启
                                    └─ ≥1：原子写入 → 面板刷新 → 提示手动重启
用户确认重启 → disposeWorkspace（可中断任务）→ 重新读取原生目录
```
