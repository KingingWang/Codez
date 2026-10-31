# Conversation share attachment

只包装既有 Share 服务与 Agent 读取端口。Share 服务拥有发布、导入和进度事实，窗口连接 owner 拥有受信 attachment；包装器不持有第二份连接、订阅、任务或业务状态。

```text
desktop-continuous → 受信 attachment → 原 Share 服务 → 同一 Agent 读取端口
web-remote-replayable → 仅公开预览；发布 / 导入 / continuation 拒绝
```

Source relay 从每次请求读取受信下游身份，不读取控制端 JWT。缺少受信 attachment 或 Agent 端口时按当前 `connection_unavailable` 语义失败；手机业务操作保持 `feature_disabled`。操作 ID、进度事件与幂等性仍由原 Share 服务管理，不另建 hello、连接或恢复流程。

本模块以 metadata 目录和 `conversationShareConnectionScope.ts` 精确 roots 登记。现有 helper 保留为兼容公开入口，不将整个 `conversation-share` 目录或 Service 实现放宽为公开接口。

原 Share owner 注入只读 reader 展开 Codex 共享内容；内容 ID、sha、格式与字节预算沿用原校验。缺能力、身份不符、缺记录、校验失败或超预算均 fail-closed，不截断或派发不完整 prompt。`codexSharedContextContentCopy.ts` 是同一 owner 的精确公开端口，不新增发布、连接或恢复状态。
