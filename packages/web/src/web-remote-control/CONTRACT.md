# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接；挂起与原 socket 探测期间，只有当前有效配对 socket 的 raw 帧进入 adapter 并只放行其 ACK，普通 app data 与新发送仍需 paired。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

扩展客户端可以为首次 relay 配对设置有界期限；超时只终止尚未配对的首次连接并交给入口显示安全诊断码。首次配对成功后，该期限撤销，后续网络/休眠重连仍由 transport 的既有恢复状态机处理，不另起状态 owner。浏览器扩展 HTTP 桥必须交付真实响应，不能把 runtime 的空 Promise 结果当作成功，也不能在桥失败时退回页面跨域请求。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

失效通知按 bridge identity 幂等消费，raw adapter 的首次 degraded 转换是唯一恢复入口。
恢复中的已选任务不因 bootstrap 工作区候选缺席而丢失；缺席目标沿既有 Host 任务导航核验，
明确离线的候选保留断线语义，无 taskId 的草稿不进入任务导航。不得缓存旧 remoteSessionId。
上述恢复规则要求显式提供 preferredWorkspaceKey；冷启动与整页刷新复用初始选择器，旧导航
缺席或离线时优先选择可 bridge 的 workspace，不对缺席目标发起 Host 任务导航。

每个 bridge 的 RPC client 受 acknowledged adapter 的生命周期信号约束。degraded/dispose
终结在途及尚未初始化的调用，迟到回包无效；同 bridge 的挂起、短断线和 replay 不撤销信号。
未提交草稿由既有 Composer 失败处理恢复，已登记命令继续由 query/snapshot 对账。
transport 的 `ensureConnectionReady({ timeoutMs, failureReason })` 统一健康复用、在途握手等待、
后台探测与故障升级；requester 只关联响应、透传恢复原因并合并并发重试，不另建连接 owner。
正常工作区切换不重配对；Root 继续按 bridge identity 隔离，后续加载不显示首次连接阶段。
bridge admission 的同 identity 重试仅限同一加密会话；E2EE reset 后取消旧请求，由已有导航/
恢复流程使用新 identity/generation 重开，迟到结果不能覆盖新导航。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。
