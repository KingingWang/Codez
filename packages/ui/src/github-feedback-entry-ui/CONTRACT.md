# GitHub 反馈入口

原 useFeedbackEntryAction 持有展示需要的设备诊断投影；Host feedback port 仍是设备事实来源。
title/errorSummary/description 统一在 feedbackEntryPlan 脱敏、限长，再生成 GitHub Issues URL。
连接失败只传用户可见摘要，原始日志、凭据和真实内部地址不得进入外部 URL。

平台打开仍经 IPlatformService；缺少 Provider 或平台能力返回原 unavailable 语义。
不恢复旧表单/附件上传流程，不新增 ticket 状态、反馈服务或日志 owner。
contract 复用公共平台和诊断服务类型，不反向导出实现。
