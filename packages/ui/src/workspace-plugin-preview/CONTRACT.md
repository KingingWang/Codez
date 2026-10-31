# Workspace plugin preview

负责工作区入口的插件缩略图和选择列表；通过既有 catalog hook 获取数据，不持有另一份插件安装状态。

仅启用且无冲突的插件可引用。选择输出 canonical plugin mention；浏览市场沿用既有导航事件。workspace/session 隔离、排序和加载状态保持原有逻辑。

缩略图和列表复用 PluginIcon 的图片尺寸规则，不覆盖 img 大小；缺失图片的占位图标仍为 16px。共享图片按原比例完整展示，圆角由容器裁切。

`pluginIconSource.ts` 以精确 root 纳入同一展示模块，作为兼容公开入口供市场、mention 和消息投影共用。它按完整插件 ID 解析客户端打包图标，其余来源仍走现有 trustedImageUrl；只放行已知打包资源，不能扩大到任意本地 URL。此处不新增插件安装态、图片缓存或信任策略 owner。
