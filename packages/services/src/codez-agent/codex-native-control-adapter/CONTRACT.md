# Codex native control adapter

Local Host/Helper、原 browser relay 和 Main broker 保持各自唯一 owner。
本模块登记 grant publisher、remote-local relay 与 managed skill，不扩大控制权限。

```text
Helper ready → 原 grant owner(epoch fence) → native bridge
                                                  │
                     原 remote relay → Window Host → Main broker
```

- grant 仅在当前 Helper ready 后原子发布；restart 撤销旧值，dispose 和迟到 ready 受原 epoch fence 保护。
- 文件清理只针对原 owner 目录；日志不输出 token、capability 或凭据载荷。
- Main 窗口 token 不离开桌面；远端仅持有原 relay 自签发 token。
- requestId 只关联一次 native mutation，已投递命令不因订阅恢复而重发。
- socket 沿用完整帧字节解码、请求 1 MiB/响应 32 MiB fail-closed 上限；不引入字符串跨片解码。
- managed skill 复用当前同步端口；模块登记不新增原生 HOME、用户数据或缓存写入路径。
- 不另建 Agent、Host、accepted queue、V4 snapshot 或手机控制 runtime。
