# CUA smoke

三个现有显式 smoke 只在各自 opt-in 为 1 时访问真实桌面。Helper 和 packaged node_repl
走原 IPC tuple/broker 链并回收原子进程；local smoke 明确使用包内 driver seam并可能移动指针。
它们不成为产品 fallback，不把无桌面跳过报告为真机成功。

mock Node 回归和运行时闭包工程测试独立执行，不被这些 opt-in 脚本替代。
