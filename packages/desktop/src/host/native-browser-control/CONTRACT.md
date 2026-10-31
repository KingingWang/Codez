# Desktop native browser control Host adapter

Main 是窗口 token、capability 与执行的唯一权威。Host holder 只投影 InitLocal/live
push 的 descriptor，供已有 spawn/remote relay 读取；endpoint 与 token-file 路径不在
Host 重建，browser 授权缺失时不因 CUA 载体存在而开启远端 relay。

每个请求读取当前 Main 窗口 token，只替换 payload 的 token，通过同一 socket 返回原始
响应行。真实 token 不入 config、日志、UI 或远端持久化；无凭据、不可达、close、
timeout 和 32 MiB 溢出均返回原 request ID 的失败帧，不重发 mutation。

连接内按原始字节累计，只扫描新 chunk 的换行；完整帧才一次 UTF-8 解码。累计原始
接收字节保持 32 MiB fail-closed；没有换行不返回部分响应。单连接单次结算，完成后
忽略迟到 data/close，不影响其他请求。Main/remote 的 request bound 仍为 1 MiB。

事件顺序：Main push → holder 更新 → 原 Host runtime dispose/下一次 spawn；native
执行仍是 remote relay → 同一 window Host → Main → 原 BrowserGuestManager。
详细规则与可重复 socket 验收见 `specs/codex-desktop-native-browser-cua.md`。
