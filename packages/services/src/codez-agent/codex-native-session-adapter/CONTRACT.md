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
