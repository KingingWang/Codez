# 加密远控与 Gzip 线协议

精确登记 `web-remote-control-e2ee.ts` 与 `web-remote-control-gzip.ts` 的既有严格 schema、
版本和预算。它们属于 contract，不持有密钥、nonce/序号、socket、压缩器或 attachment。
relay 内部线字段原样保留 `zcode_type`，不能随品牌转换改为 `codez_type`。

```text
accepted app payload → negotiated Gzip envelope → existing E2EE record → relay
same owner routing  ← authenticated payload     ← existing E2EE record ← relay
```

握手和重放检查、密钥/连接代际仍归各自 transport；Gzip 仅在能力协商后启用。
解密鉴权后才解析封套和业务消息，不能以 wire schema 校验代替认证或提前 attach Host。
desktop-continuous 不经过此手机恢复链路；手机仍复用同一 Host 的 replayable attachment。

依据：[端到端加密](../../../../docs/web-remote-control/end-to-end-encryption.md)、
[上游 wire 兼容](../../../../specs/mobile-remote-upstream-wire-compatibility.md)。
