# Codex usage observation

现有 CodezAgentService 按所属 Host/workspace 唯一持有观察缓存；
native usage 是来源事实。本模块只登记 cache/read-model，不创建统计持久化或第二份真值。

```text
所属 Host 的 native usage → 原 workspace cache → 同一 JSON snapshot → UI
```

- workspace key 使用 identity-or-path；观察 ID 不含时间戳、delivery ID 或连接代际。
- 稀疏值与同一 canonical observation 保持去重；回退计数按原 conflict 语义展示，不静默改成累计值。
- RPC snapshot 的 threads 是有序数组，不用 Map 传输；stale 只表示 runtime 可用性，不删除已知事实。
- reconcile/observe/markRuntimeUnavailable 仍命令同一个原 cache owner。
- 不读取或合并 Coding Plan 数据；服务器统计按原所属 Host 作用域汇总。
- 实现包含 native crypto 哈希，不把这组 application state 机械标为 domain。
