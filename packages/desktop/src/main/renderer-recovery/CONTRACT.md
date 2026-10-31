# Desktop renderer recovery

每个主窗口的既有 handler 唯一持有 auto-reload 预算；Main 提供 quitting、WebContents
存活性、reload、schedule 与日志端口。可恢复原因先原地 reload，超预算只告警并停止；
primary-window recreate 仍是原生命周期的最后入口。

延迟回调执行前复验 quitting/liveness；失败只告警，不无限 retry，不创建 Agent，不
回收/替换 Host attachment，不保存会话状态。返回值保留现有“已安排 reload”的语义，
不冒充原生页面已经恢复完成。验收复用现有 codexRendererCrashRecovery 回归。
