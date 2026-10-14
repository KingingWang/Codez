# 手机远控重连恢复风暴与快照交接

## 问题与产品规则

2026-10-14 日志（Windows 桌面 + 手机 5G，约 360KB/s 下行）：手机查看一个
838 条消息、仍在运行的会话时，raw relay bridge 每 15~90 秒因
`remote.rpcFrame.replayBufferExceeded`（未 ACK 字节超过 8MiB replay buffer）
降级一次，整夜循环 13 次以上。症状：

1. 手机状态栏持续约 1MB/s 的数据传输，界面加载完成后也不停；
2. 会话页（前台或后台恢复后）长期停在空白 + 转圈，不自动恢复。

根因是自激循环，而不是单次大帧：

```text
bridge 降级
  → 手机 recoverVisibleSession → bootstrapPairedSession → 重建 bridge
  → Root 以新 bridgeSessionId 整树重挂（SessionDataLayer/store 全部销毁）
  → 新 store 无 base 全量订阅：会话快照（尾窗 60 行，运行中会话可达数 MB）
    + sessions-index 种子 + plans + 每张可见图片的 attachmentReadV4
    （512KiB/片）+ bootstrap/workspace-list app payload（546 任务约 375KiB）
  → 突发远超移动链路 ACK 排空速度，1MiB 高水位饱和信号还没传回 CLI，
    8MiB replay buffer 已被打爆
  → bridge 再次降级（实测最快 attach 后 3.5 秒）
```

循环每轮重发数 MB，叠加后就是持续的高带宽；会话页在每轮重挂间拿不到稳定
首帧，所以永远转圈。

产品规则：bridge 恢复必须是**增量**的——只要 CLI 保留窗还覆盖，恢复只补
`(base.seq, current]` 的 delta；恢复期间手机必须立即展示最近已知内容，
不允许回到空白转圈。

## 唯一所有者与事件顺序

- 快照交接缓存：`packages/ui/src/v4/conversationSnapshotHandoff.ts`（模块级
  Map，按 topic 最多 2 条，TTL 30 分钟）。唯一写入点是
  `ConversationProjectionStore.close()`（快照已完整应用、是一致投影）；
  唯一消费点是 `ConversationProjectionStore` 构造（取走即删，单消费者）。
- 事件顺序：旧 store `close()` 写入交接 → React 旧子树 effect 清理
  （`layer.dispose()` 同步 close 全部 store）→ 新子树 effect `acquire()` →
  新 store 构造取走交接 → `connect()` 自动以 `snapshot.{logEpoch,seq}` 为
  base 发起 subscribe → CLI `subscribeReserved` 裁决：
  `base.logEpoch === publisher.logEpoch && floorSeq <= base.seq <= currentSeq`
  时 resume（保留窗内重放增量），否则回退全量 snapshot（客户端规则 1 整体替换）。
- 一致性不变量不变：base 与状态同生共死；交接快照只是「上一个一致水位」，
  CLI 拒绝时新 store 退回全量快照，断档不猜的既有规则不受影响。
- artifact 图片缓存：
  `packages/ui/src/components/ai-elements/artifactImageCache.ts`
  （模块级 LRU，24 条 / 48MiB，逐出时回收 objectURL）。
  `codez-artifact://` ref 是内容寄存引用，同 `(sessionId, ref)` 字节不变；
  `MarkdownImage` 命中缓存即跳过 `attachmentReadV4`。
- 任务列表去重：手机 `main.tsx` 的 `listWorkspaces()` 在途合并（并发调用
  共享同一个 Promise）；`bootstrapPairedSession` 把 bootstrap 响应里的
  workspaces/tasks 直接作为 `initialWebRemoteControlWorkspaceList` 传给 Root，
  bridge 模式下首页挂载不再重复发 workspace-list-request。

## 2026-10-14 追加：压缩、推送节流与恢复退避

同日第二轮生产日志（macOS 桌面 + 手机前台可见）显示增量交接之外仍有两处
结构性洪水源，加上 E2EE 密文使 permessage-deflate 完全失效（见
[端到端加密](./end-to-end-encryption.md)「应用层压缩（relay-gzip）」），
活锁仍可自激。追加三条边界：

- **relay-gzip 应用层压缩（先压缩后加密）**：桌面→手机下行大 payload 以
  gzip 信封传输，replay buffer 计量的 outer bytes 同步缩小约一个量级。
- **桌面任务列表推送节流**：`syncAvailableTasks`/`syncAvailableWorkspaces`
  的 `workspace-list-updated` 推送按窗口尾沿合并（默认 1.5s，测试可注入
  `workspaceListPushThrottleMs`）。运行中任务每次 displayStatus /
  workflowActivity / unreadAt 翻转都会改变签名，无节流时每次翻转都全量推
  整份列表（456 任务约 283KB/次，实测一秒内十几次）。窗口内只保留一个
  定时器，触发时重新构建结果与签名，手机最终拿到最新态而非中间态；
  请求响应路径（bootstrap / workspace-list request）不节流。
- **手机恢复退避**：`bridge-degraded`（桌面通知）与本地协议降级
  （frame gap/fault）驱动的自动恢复进入滑动窗口计数，前 2 次立即恢复，
  第 3 次起按 5s/10s/20s 递增、30s 封顶延迟（
  `packages/web/src/webRemoteControlRecoveryBackoff.ts`）。窗口 120s 内无
  降级自动清零；用户生命周期恢复（回前台/pageshow/online/手动）不受退避
  影响并清零计数。恢复仍由 `recoverVisibleSession` 单 owner 执行，延迟
  只推迟发起时刻，不改变增量交接语义。

## 不做什么

- 不改 replay buffer / 高水位 / 45 秒 grace 的取值：降级本身是正确的有界
  保护，问题在恢复成本。手机后台 ACK 停滞导致的降级仍会发生，但恢复变便宜后
  不再形成风暴。
- 不引入跨 tab 协调（多 tab 共用 deviceSid 的仲裁另案处理）。
- sessions-index store 同样支持 base，但本次不加交接缓存；首帧只有单 workspace
  的任务摘要，量级远小于会话快照。

## 验收

1. store 关闭后重建：`connect()` 携带 `base = { logEpoch, seq }`，ACK 为
   resume 时快照在 ACK 前已可渲染（status=connecting + snapshot 非空）。
2. 无交接或 TTL 过期时行为与之前一致（全量快照订阅）。
3. `MarkdownImage` 重挂后命中缓存，不再调用 readAttachment；卸载不 revoke
   缓存持有的 objectURL，逐出时回收。
4. 手机端恢复一轮的 raw RPC 流量从「快照 + 索引 + 图片全量」降为增量 delta；
   workspace-list 每个 bootstrap 周期至多一次请求。
5. `pnpm typecheck`、`pnpm lint`、`packages/ui` 相关 vitest 全绿。
