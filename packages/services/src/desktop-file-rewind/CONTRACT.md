# Codex file rewind

原 Host file-rewind service 与 ledger 持有确认、备份和补偿状态。
UI 只使用原 service port；本模块登记六个既有文件，不增加回退写入路径。

```text
原投影 target/revision/epoch → preview → 用户确认
                                           ↓
原 ledger → 备份及校验 → restore 及校验 → 同一状态结果
```

- workspace identity、session、target、revision 与 log epoch 均在执行前复验；不能仅凭 cwd 判断目标。
- 不安全/缺失投影 fail-closed；用户确认与 confirmationId 沿用原协议。
- ledger、patch、文件读取和 plans 留在 adapter 内，不把 Repo 或文件 IO 暴露给 UI。
- 备份验证先于恢复；失败保持原 needs-manual-recovery 语义，不伪造成功或丢弃可恢复资料。
- projection overlay 仅派生既有结果，不修改 native 转录、Host 组织态或 accepted queue。
- desktop/mobile 沿用所属 Host 的同一个服务端口和原 capability gate。
