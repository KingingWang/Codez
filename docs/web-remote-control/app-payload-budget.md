# 手机远控 app payload 字节预算

## 问题与产品规则

2026-10-13 日志：桌面把 `bootstrap-response` / `workspace-list-response` /
`workspace-list-updated` 序列化到 1,054,465 字节，超过 relay 物理帧 1MiB 硬上限
（`PROTOCOL_V4_LIMITS.maxFrameBytes`），被 transport 整条拒发。手机永远收不到
bootstrap-response，进入 recover 循环后提示“桌面端响应超时”
（`desktop-bootstrap-timeout`），且任务列表内容不变化就一直无法恢复。

失控来源：renderer 同步 pinned + timeline + archived 全量任务（无条数上限），任务
`title` 无长度上限（真实数据存在 122KB 的单条标题——完整 prompt/日志被当成首条消息
截进标题），叠加 v3.15.1 引入的 archived 同步与逐任务 workflowActivity。

产品规则：手机能看到的工作区与最新任务必须总是可达；列表内容超出传输预算时，
先牺牲超长标题的尾部，再牺牲最旧任务，不允许整条 payload 不可达。

## 唯一所有者与边界

- app payload 走 relay data message 单帧发送，不使用 raw RPC 分片；1MiB 物理帧
  上限与 e2ee 密文封套（base64(nonce+明文+tag) + envelope）由
  `WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES = 700KiB` 明文预算覆盖，
  与 `WEB_REMOTE_CONTROL_E2EE_RPC_PHYSICAL_BUDGET` 同一姿势。
- 发送侧约束只在 Desktop Main 的 `webRemoteControlManager` 构建
  bootstrap/workspace-list 结果时发生：
  `webRemoteControlPayloadBudget.ts` 是纯函数唯一实现，先截标题
  （`WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS = 200` 字符），仍超预算再按
  updatedAt 倒序丢最旧任务前缀之外的尾部。只改出站快照，不写回 renderer 或
  持久化状态。
- 推送签名（`buildWorkspaceListPushSignature`）基于截断后的实际出站结果计算；
  payload 被判 oversize 丢弃时不得记录签名，之后相同快照必须能重试。
- 手机端协议 schema 不变：workspaces/tasks 字段不变，只是内容更少、标题更短。
  上游托管页面与本仓库 Pages 页面都不需要配合修改。

## 验收

1. 构造 900+ 任务且含 122KB 标题的列表，bootstrap-response 明文 ≤ 700KiB，
   密封估算 < 1MiB，最新任务与截断标题保留，桌面记录一次
   `trimmed workspace list app payload` warn。
2. 小列表不产生任何截断或丢弃，bootstrap/workspace-list 行为与之前一致。
3. `workspace-list-updated` 被 oversize 丢弃后，相同内容的下一次同步必须重新尝试发送。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与
   `webRemoteControlPayloadBudget` / `webRemoteControlManagerExternalRelay` 测试全绿。
