# 侧边栏任务悬停详情卡片（Task Hover Card）

## 背景与目标

侧边栏任务行受限于固定宽度，长标题通过右侧渐隐省略展示，且单行任务（置顶区、项目展开列表、底部「任务」分区、分组视图）缺少完整的目录归属、远程主机名称及更新时间概览。需要为侧边栏所有任务行提供统一的右侧固定位置悬停详情卡片。

## 产品规则与交互边界

1. **启用范围**：
   - 覆盖侧边栏全部正式任务行：置顶任务（`pinned`）、项目展开列表任务（`project`）、底部「任务」分区任务、分组视图任务（`GroupedTaskRow`）以及时间线视图任务（`timeline`）。
   - 手机 Web 远控（`isWebRemoteControl`）及无悬停触屏环境（`hover: none`）、拖拽预览（`dragOverlay` / `tooltipsDisabled`）、归档二次确认态（`isArchiveConfirming`）或右键菜单打开期间不弹出任务详情卡片。
2. **定位与防闪烁规则**：
   - 悬浮卡片锚定在任务行容器右侧边缘（`side="right" align="start" sideOffset={8}`），固定显示在侧边栏右侧，不随鼠标在任务行内水平移动而改变位置。
   - 继承 `SidebarTooltipProvider` 的 `300ms` 延迟与 `pointer-events-none` 透传样式，不阻挡相邻元素鼠标事件。
   - 当指针移入任务行内的操作按钮（置顶、归档、查看文件树、移到顶部、关闭）或操作按钮获得焦点时，自动抑制整行任务详情卡片，仅展示对应操作按钮的提示。
3. **卡片展示内容（唯一数据源派生）**：
   - **头部**：
     - 完整任务标题（支持多行自然换行，不截断）。
     - 环境标识图标：本地任务显示 `Laptop` 图标（`text-foreground-subtle`），远程任务显示 `Globe` 图标（`text-remote-foreground-muted`）。
     - 相对更新时间（`taskTimeLabel`）。
     - 可选代码变更统计：当任务存在非零文件变更（`+added` / `-removed`）时，在头部时间旁展示新增/删除行数。
   - **目录行**：显示 `Folder` 图标 + 任务绑定目录名称（`workspaceLabel`）。
   - **远程主机行（仅远程任务）**：当任务为远程任务且解析出主机名（优先 `serverDisplayName`，回退 `ProjectDirectoryProvider` 中的 `deviceNames` 与 `directory.hosts`）时，显示 `Globe` 图标 + 远程主机名称；**本地任务不渲染该行**。

## 状态所有者与数据流

```text
ProjectDirectoryProvider (tree + directory.hosts + deviceNames)
  └── TaskListItem / GroupedTaskRow (只读派生 resolveTaskHoverCardMeta)
        └── TaskHoverCard (Tooltip 局部 hover open 状态，行内按钮悬停时抑制)
```

- 不新增持久化或全局 store 状态；所有展示字段均从当前任务 `CodezTaskMeta` 与 `ProjectDirectoryProvider` 只读投影即时派生。

## 验收场景

1. **本地任务悬停**：卡片固定在侧边栏右侧，头部展示完整标题、`Laptop` 图标与相对时间（及可选 `+added -removed`），下方仅展示 `Folder` + 目录名，不展示远程主机行。
2. **远程任务悬停**：卡片头部展示完整标题、`Globe` 图标与相对时间，下方依次展示 `Folder` + 目录名、`Globe` + 远程主机名。
3. **行内操作按钮优先**：鼠标从任务标题移向行内「查看文件树 / 归档 / 置顶 / 移到顶部 / 关闭」按钮时，任务详情卡片收起，按钮自身的动作提示正常显示。
