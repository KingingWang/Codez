# Codex 原生设置协议

登记 `codex-runtime.ts` 与 `codex-native-provider-key.ts` 的既有 schema；不移动源码、
新增 RPC、复制配置或创建运行时。两文件和本目录属于纯 contract 层，公共入口保持兼容。

Codex 持有原生账号、模型和配置事实；所属 Host 持有 Provider Key 的私有存储与逐连接安装。
设置请求只允许当前 settings RPC allowlist，不能借此开放 thread、tool 或文件操作。
标题偏好继续以 `workspaceIdentity?.trim() || workspacePath` 隔离；Provider 写目标不因
Agent 重启代际失效。schema 本身不保存凭据或发布 ready。

依据：[原生适配](../../../../specs/codex-desktop-adapter.md)、
[临时 Key](../../../../specs/codex-provider-runtime-env-key.md)、
[上游集成](../../../../specs/upstream-main-integration.md)。
