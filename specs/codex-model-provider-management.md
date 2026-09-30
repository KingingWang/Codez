# Codex 模型供应商与目录模型的 GUI 管理

Status: 实现中。设置 → Codex 新增「模型供应商」面板：直接管理 config.toml 的
`model_providers` 与 `model_catalog_json` 目录文件中的模型条目，不再只能手编
TOML/JSON。分组显示与跨 provider 路由的事实源契约见
specs/codex-model-provider-grouping.md，本 spec 只定义管理（写）路径。

## 产品规则

- 面板分两个区块：**供应商**（`model_providers` 表）与**模型**（catalog 文件
  条目）。模型按 catalog provider 分组列出，与 composer 下拉同一归属口径。
- 供应商字段（MVP）：id、name、base_url、wire_api（chat/responses）、
  API Key（`experimental_bearer_token`）、requires_openai_auth。id 创建后不可改
  （TOML 表键即身份；改名 = 新建 + 删除）。
- API Key 明文写入 config.toml（codex 原生 `experimental_bearer_token` 字段，
  RedactedString 日志打码；桌面端尤其 macOS 无法可靠注入环境变量，`env_key`
  引用模式对 GUI 用户不可用）。**UI 只写不回显**：config/read 会返回明文，
  面板只呈现「已配置」状态；输入新值才覆盖，留空 = 不修改；提供「清除」
  （写 null 删键）。
- 模型字段（MVP）：slug、provider（下拉，限已有供应商）、display_name、
  description、visibility（list/hidden，hidden 不出现在 model/list 默认视图但
  保留配置）。其余能力字段（context_window、reasoning levels 等约 30 个）经
  **单模型高级 JSON 编辑器**维护：编辑表单内折叠区直接编辑该条目的完整
  JSON；新增模型时从同 provider 现有首条模型复制能力模板，只允许先改
  slug/display_name/description/provider。
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
  - 删除模型：slug 等于 `config.model`（新线程默认模型）时给出警告但允许。
  - 「设为默认供应商」写 `config.model_provider`；codex 的
    check_thread_model_provider 只校验托管要求，用户层变更不会 invalidate
    现有线程路由（0.157.1 源码核实）。

## 事实源与所有权

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
- **codex 启动期快照限制**：配置了 `model_catalog_json` 时 codex 用
  StaticModelsManager 持有启动期目录快照，`model/list` 不随文件变更刷新
  （reloadUserConfig 只重载线程 Config）。因此目录写入后：
  新 turn 路由立即生效（线程 Config.model_catalog 已重读）；GUI 模型下拉
  （model/list 数据源）需重启 workspace runtime。面板在目录写入成功后显示
  该提示并提供「立即重启运行时」动作（codezAgentService.disposeWorkspace，
  中断该工作区在途任务，需用户确认）；不重启也不产生错误状态。
- 供应商写路径不需要重启：provider 定义在 turn 时从线程 Config 解析。

## 合同

新增 bridge 控制面方法（`codezProtocolMethods`）：

- `catalog/readModels`：`{ path: string | null, models: unknown[] }`。
  返回目录文件中的完整原始条目（含全部能力字段），供管理表单与高级 JSON
  编辑器使用；未配置目录文件时 `path` 为 null、`models` 为空。
  每条目至少校验为带 string `slug` 的对象，否则整条目读取失败诚实报错。
- `catalog/writeModel`：`{ workspace, model: <完整条目 JSON> }`。按 slug
  upsert：同 slug 替换整条，否则追加到 models 末尾。条目必须是带非空 string
  `slug` 的对象。原子写（同目录 tmp 文件 + rename）。
- `catalog/deleteModel`：`{ workspace, slug }`。按 slug 删除；不存在时报
  未找到错误（调用方据此提示，不当成功处理）。

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
