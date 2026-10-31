# Codex 设置 UI

原设置 hooks 持有表单草稿、读取代际和 mutation guard；目标 Host/native config
持有 accepted 配置、Provider Key、目录与账号事实。原 workspace/identity/remote session
作用域贯穿服务端口，服务不可用不能降级旧配置写入并声称保存成功。

Provider 写目标不包含 Agent 代际；同一目标的轮换重启通过 deferredRuntimeRestarts
延后，errorTarget 保留失败。真实 workspace/service 切换仍使旧结果失效。
Key 的 prepare/write/finish（失败 rollback）复用原 port，不在 UI 持久化密钥。

catalog single-flight、瞬时读取重试和模型失效继续由既有 hooks/Host 承担，不新增缓存。
native hooks、MCP、memory、resources、agents、history、title-model 和 Gemini wire API
面板保持原语义。metadata 不恢复 Node/App 测试，也不接管整片 settings 目录。
