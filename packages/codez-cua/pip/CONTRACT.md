# PiP

原 coordinator 是 focus revision、turn sequence、截图绑定和 presenter 可见性的唯一 owner；
socket adapter 只串行投递已认证事实，沿用单一 writer epoch 与迟到结果防护。
同一 tuple 的旧 writer 不能改新连接；重复/stale 事件不制造新的显示状态。

capture 容量在克隆状态提交前核算，presenter 失败不提交状态；PiP 旁路故障不能改变真实
native 观察结果。close/dispose 和已有平台 presenter 行为不变。
