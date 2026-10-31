# Desktop update presentation

只从当前产品档位和 updater 事件推导菜单可见性、文案 ID 和参数。Main 的既有 updater 仍是检查、下载、安装和重启生命周期的唯一 owner，本模块没有 IO、事件发布或本地状态。

production 与 codex 保留手动检查入口，preview 不启用。菜单复用当前 checking、available、progress、downloaded 等事件标签，不修改 updater 的下载来源、重试或同版本去重规则。

以 metadata 目录和 `desktopUpdateMenu.ts` 精确 roots 登记；保留原 helper 作为兼容公开入口，不扩大整个 `lib` 的可见性。
