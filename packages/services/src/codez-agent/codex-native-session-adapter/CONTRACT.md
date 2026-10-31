# Codex native session adapter

精确登记既有 command resolver、stderr/title 诊断和事件差分投影，不接管整个
CodezAgentService 或 ProcessManager。原文件保留兼容公开入口，契约只复用真实类型。

```text
ProcessManager → 原 stdio bridge / CLI thread → 受信 frame → 既有事件投影
                         └── 生命周期诊断 → 原 Host logger
```

- CLI/native thread 拥有会话与已接纳输入；本模块不保存第二份 accepted queue。
- ProcessManager 仍拥有启动/退出；command resolver 不构建、不下载、不新增重启策略。
- projector 只保存可丢弃的帧差分读模；dispose 不修改 native 会话或 Host 组织态。
- desktop-continuous 与 web-remote-replayable 沿用原 attachment/flow owner，不能仅凭 cwd 合并身份。
- 原生诊断进入 Host 日志，不被登记动作转换为 composer 内容或 V4 业务事实。

Host 兼容边界：原生与 legacy runtime 的 interaction/model-IO/memory 偏好共用
既有 `interactionPreferenceSyncByClient`，物理 `CodezProtocolClient` 是串行链的唯一
所有者；workspace ref 只决定每条命令的目标，不另存 workspace-key 同步链。
单 workspace 释放不拆断共享 client 的串行顺序；链尾只在仍为当前 Promise 时清理，
runtime 换代以新 client 建立新链，不复用旧代完成态。

```text
Host 设置快照 → 同一 client 的串行链 → 携带 workspace ref 的协议命令
                                        └→ 原 runtime 偏好投影
runtime unavailable → 旧 client 失效 → 新 client 同步最新快照
```

验收复用既有回归，覆盖缓存但不拉起进程、连续快照有序应用、同步失败后重试和
runtime 重建后重新同步；不改变 CLI/native thread 的事实归属或 accepted queue。
