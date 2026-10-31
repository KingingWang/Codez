# Git 工作树 UI

既有创建、删除和分支操作 hooks 是 UI 草稿、在途 operationId 与确认结果的唯一 owner；
真实 Git 台账、锁、preview digest 和幂等执行仍由所属 Host 的 Git port 持有。
目录用于执行，`workspaceIdentity?.trim() || workspacePath` 用于身份；不按同 cwd 合并远端。

发现仅查询已打开且已连接的服务，不拉起 Agent、Host 或新连接。删除沿用预检、
目标运行时隔离/释放、关闭 tab、原操作提交和未知结果恢复顺序；服务须在关闭 tab 前解析。
表单、runtime hold 与 Root 导航保持原 owner，不复制 accepted operation 或增加计时兜底。

contract 只公开已有 Git/Task 类型端口；旧路径仍是兼容入口。Dialog 从 model/contract
读取类型，不反向依赖负责挂载 Dialog 的 hook。E2E 与既有 fork 回归仍使用原入口。
