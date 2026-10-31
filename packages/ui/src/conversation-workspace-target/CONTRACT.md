# Conversation workspace 目标解析

模块组合 Root 提供的操作端口，解析“在项目外工作”的目录和身份。窗口 tab store 是 tab 的唯一 owner，Registry / SourceManager 是远程连接和 Source 归属的唯一 owner；解析器只读取事实，不保存副本。

远端不能解除项目绑定，直接拒绝无项目目标。路径相同不能代表设备相同；Source 解析只消费持久化 alias，含糊结果不猜。workbenchTarget 仅解析分屏焦点，最终创建仍交给 ProjectService 按显式项目准入。本地继续使用既有目录解析端口。调用方只使用公开入口和契约。

修复原因：原解析文件落在未受管的 ui 模块，阻塞 pre-push。现在用独立 app 层承载端口编排，契约采用最小只读 tab 视图，避免反向依赖 Root / Zustand。

此模块不改变桌面 continuous、手机 replayable/shared-host、连接重用或持久化边界；具体打开行为与重试语义继续由注入端口负责。

插件创建菜单和控制器复用 workbenchTarget 解析焦点项目；设置菜单只发起同一创建命令，预填在目标会话成功创建后消费，不持有第二份项目状态。

`workspaceRemovalSafety.ts`、`workspaceRuntimeRelease.ts` 与 `pluginCreatorPrefill.ts` 以精确 roots 纳入此模块，保留原 helper 的兼容公开入口，不放宽整个 lib、settings 或 store。删除风险扫描只通过注入的 FileService 有界读取，失败或截断仅为风险提示，不写文件；运行状态仍读取现有会话投影。

```text
窗口删除编排 → Host 隔离目标准入 → 释放全部 runtime → 关闭 tab → 原删除端口
           └──────── 成功 / 失败结束后解除 Host hold ───────────────┘
```

Host service 拥有删除隔离，窗口 tab store 拥有关闭状态。服务解析与释放使用关闭前同一份 tab 快照，释放失败必须保留全部 tab 并中止物理删除；仅从项目列表移除后的释放继续是记录错误的异步清理，不混同物理删除。所有目标沿用 `workspaceIdentity?.trim() || workspacePath`，不把相同 cwd 当作同一远端。

插件预填只消费官方、启用且有效的 plugin-creator skill，异步读取后仍须通过当前目标 guard；不改变创建 owner，不引入第二份草稿或技能缓存。
