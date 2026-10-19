# Codex 模型供应商与目录模型的 GUI 管理

Status: 实现中。设置 → Codex 新增「模型供应商」面板：直接管理 config.toml 的
`model_providers` 与 `model_catalog_json` 目录文件中的模型条目，不再只能手编
TOML/JSON。分组显示与跨 provider 路由的事实源契约见
specs/codex-model-provider-grouping.md，本 spec 只定义管理（写）路径。

## 产品规则

- 面板分两个区块：**供应商**（`model_providers` 表）与**模型**（catalog 文件
  条目）。模型按 catalog provider 分组列出，与 composer 下拉同一归属口径。
- 供应商字段（MVP）：id、name、base_url、wire_api（chat/responses/anthropic）、
  API Key（`experimental_bearer_token`）、requires_openai_auth。id 创建后不可改
  （TOML 表键即身份；改名 = 新建 + 删除）。
- 配置文件来源的 API Key 明文写入 config.toml（codex 原生
  `experimental_bearer_token` 字段，RedactedString 日志打码）。本机临时来源由
  Codez Credential Store 持值，Codex `env_key` 仅存引用；App 在 Agent spawn
  时定向注入，不依赖 Finder/终端继承环境。完整边界与验收见
  [codex-provider-runtime-env-key.md](./codex-provider-runtime-env-key.md)。
  **UI 只写不回显**：config/read 会返回原有明文，
  面板只呈现「已配置」状态；输入新值才覆盖，留空 = 不修改；提供「清除」
  （写 null 删键）。
- 模型字段（MVP）：slug、provider（下拉，限已有供应商）、display_name、
  description、visibility（list/hidden，hidden 不出现在 model/list 默认视图但
  保留配置）。其余能力字段（context_window、reasoning levels 等约 30 个）经
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

```text
codex-bridge main 启动
  ──→ ensureDefaultCodexConfigFiles(env)
        ├─ config.toml 缺失 ──→ 补齐 models.json (wx) + 创建默认 config.toml (wx)
        └─ config.toml 已存在 ─→ 若 model_catalog_json 指向的文件缺失，补齐该目录文件 (wx)
  ──→ createCodexProcess (spawn codex app-server)
  ──→ GUI CodexProvidersPanel 可直接读取 user layer 与 catalog.path，新增/编辑供应商与模型
```

目录列表的可见性开关表达「在模型下拉中显示」（`checked = !hidden`），
不能在勾选时读作「隐藏」。可访问名称包含模型 slug，同名模型也必须有不同控件名。
编辑表单的独立「隐藏」开关仍表示持久化 `hidden` 草稿（`checked = hidden`）。
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
  （model/list 数据源）需重启 workspace runtime。面板在目录写入成功后显示
  该提示并提供「立即重启运行时」动作（codezAgentService.disposeWorkspace，
  中断该工作区在途任务，需用户确认）；确认时明确显示该中断风险和
  「确认重启」，不得沿用「确认移除」。不重启也不产生错误状态。
- 供应商写路径不需要重启：provider 定义在 turn 时从线程 Config 解析。

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
7. visibility 切 hidden → 下次 model/list（includeHidden=false）不再返回该模型。
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
12. 成功保存目录模型后，点击「立即重启运行时」先显示本工作区进行中任务
    将被中断和「确认重启」；取消不调用 disposeWorkspace，确认才调用。
13. 首次启动时 `$CODEX_HOME` 下无 `config.toml` 与模型目录文件：bridge 启动时自动创建
    默认 `config.toml` 与 `models.json`，Codex 原生进程正常解析启动，GUI「模型供应商」
    面板可正常读取默认供应商与模型并继续添加新供应商与模型；已有文件绝不被覆盖。

```text
GUI 已观察目录 → 展示禁用或确认 → bridge 接收 deleteModel
                                    → 读取当前文件 → 计算剩余模型数
                                    ├─ 0：拒绝，文件不变，GUI 不提示重启
                                    └─ ≥1：原子写入 → 面板刷新 → 提示手动重启
用户确认重启 → disposeWorkspace（可中断任务）→ 重新读取原生目录
```
