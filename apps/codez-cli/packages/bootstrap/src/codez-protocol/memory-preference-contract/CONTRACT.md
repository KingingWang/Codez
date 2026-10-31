# Host memory preferences

原 context 的 appRuntimePreferences 接受 Host 快照，resident record 保存有效 runtime 配置。
未受 Host 控制的字段回落 CLI 本地配置；布尔采用 host && local，模型采用 host ?? local。
本地显式关闭不能被 Host 开启反向覆盖。

使用既有 apply/update 函数与严格 schema。单会话热应用失败隔离并记录原诊断，
后续推送仍可重试；不增加设置、accepted queue 或持久化 owner。
