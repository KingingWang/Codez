# Desktop model selection attachment

原 Host model selection service 唯一持有 catalog/config/revision。此适配器只将已鉴权
mobile replayable workspace attachment 的 cwd/identity 补入既有读取，明确的其他
workspace 输入拒绝；事件按 canonical workspace key 过滤。

不凭进程 cwd、最近活动工作区或路径猜身份。Desktop continuous、source-settings 和
没有 workspace 目标的基础 scope 返回原 service，不产生新 catalog/cache/写路径。
稀疏 Codex 默认选择与 reasoning effort 原样传递，不在此处补默认值。

验收沿用 `specs/mobile-remote-upstream-wire-compatibility.md`。
