# Codex 对话展示

本模块只接收 V4/native 读模型与既有 Composer 回调。已接受的 Queue/Guide 输入、
continue 目标和轮次活动归 CommandInbox/native thread；UI 只拥有未提交草稿和在途展示。
不根据本机时间制造会话事实，不把 runtime notices 放进 composer/snapshot。

重试投影保留 native source、最近 API 错误和计数；会话累计 usage 的缺失项不当作零。
continuation 使用稳定 row/entity target，并复用原 pane 的提交回调。
desktop-continuous 和 web-remote-replayable 共享 owner，不在此模块实现第二条传输。

contract 复用共享 V4 类型，不定义队列、快照缓存、连接或服务实现。
