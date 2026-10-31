# Codex 设置 QA IO Adapters

既有 MJS runner/probe 负责 Node 文件/网络 IO、临时目录、Vite、Playwright 与 Electron
进程生命周期；这是 adapters，不是产品 UI 或 Host 服务。React fixtures 由独立 QA UI 模块持有。

每个 runner 仅为显式本地验证运行；保持原临时数据根、loopback/mock provider、权限和
清理顺序。不得使用真实用户配置、密钥或产品持久化，不自动启动全部 QA。
contract 只描述本次运行的入口和结果，不生成新的调度器、重试机制或测试。
