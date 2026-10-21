# 28 — SSH 自动认证（auto）实施票

Status: done（补齐 alias 直连入口回归）

**父规格：** [远程连接交互与视觉体验优化](./01-remote-connection-ux-optimization.md)

**来源：** GitHub issue KingingWang/Codez#14 —— 本机已配置 SSH 免密登录，但远程连接向导仍强制要求填写私钥路径。

**前置评估：** [07-ssh-agent-default-key-evaluation](./07-ssh-agent-default-key-evaluation.md)

## 要交付的行为

- 认证方式新增 `auto`（自动）选项，与 `password` / `privateKey` 并列。
  auto 模式不要求预先填写任何凭据。
- 选择不含 `IdentityFile` 的 SSH config alias 时默认切到 `auto`，已免密的主机可直接连接。
  该规则必须覆盖设置页导入、设备列表直选和已有连接恢复三类入口；各入口传递给连接流程的
  `RemoteTarget.authMode` 必须保持一致，不能只更新表单局部状态。
- auto 候选按确定顺序解析：
  1. SSH config `IdentityFile`（向导透传的 `privateKeyPath`）；加密且无口令的文件跳过。
  2. ssh-agent：`SSH_AUTH_SOCK`（POSIX 下端点必须真实存在）；Windows 无环境变量时探测
     系统 OpenSSH agent 管道 `\\.\pipe\openssh-ssh-agent`。
  3. 默认私钥白名单 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`（首个未加密可用者）。
- 全部候选不可用时，连接前即报出明确错误，引导用户改用密码或手动私钥。
- `authMode` 持久化进 Connection Profile 与远程历史 snapshot；旧记录无该字段，
  按既有规则推导（有 `privateKeyPath` 视为 `privateKey`，否则 `password`）。
- auto Profile 无需已保存凭据即可静默重连；认证被服务端拒绝时回到普通交互流程。
- 认证策略参与 Profile 去重身份：同一主机不同认证策略不被错误合并。

## 明确不支持（首期边界）

- FIDO/security-key（`*_sk`）、OpenSSH 证书、PKCS#11、Pageant、ProxyJump/ProxyCommand。
- `IdentityAgent` / `IdentitiesOnly` 语义、Match 块完整解析。
- agent 锁定/确认（`ssh-add -c`）场景的零交互保证；这些场景落在普通认证失败路径。

## 改动面

| 层           | 文件                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared 契约  | `remoteTarget.ts`（`SSH_AUTH_MODES`/`SSHAuthMode`）、`validation.ts`、`source-server/contracts.ts`、`validationAppSettings.ts`、`protocol.ts`、`test-ids.ts`                                                                             |
| server       | `remote/sshAutoAuth.ts`（新增候选解析，依赖注入便于测试）、`remote/create-backend.ts`、`remote/sshAuth.ts`、`remote/ssh-backend.ts`（`disableImplicitAgent`）                                                                            |
| desktop Host | `host/sourceServerDirectory.ts`（Profile 去重身份、编辑切 auto 清凭据、静默重连放行 auto）                                                                                                                                               |
| services     | `source-server-management/sourceServerManagement.ts`（`UpdateConnectionProfileInput.sshAuthMethod`）                                                                                                                                     |
| ui           | `hooks/useRemoteConnectionForm.ts`、`lib/remoteConnectionWizard.ts`、`lib/remoteWorkspaceHistory.ts`、`RemoteConnectionFields.tsx`、`remote-connection-flow/index.ts`、`remote-connection/EditConnectionProfileDialog.tsx`、i18n locales |

## 验收

- [x] 设置页导入无 `IdentityFile` 的 alias 默认 auto，不再报「私钥路径不能为空」。
- [x] 设备列表直选无 `IdentityFile` 的 alias 也携带 `authMode: "auto"`，不提前要求密码或私钥。
- [x] auto 候选解析单测覆盖：未加密/加密/损坏私钥、死 socket、Windows 管道、白名单顺序（`packages/server/test/sshAutoAuth.test.ts`）。
- [x] auto Profile 静默重连与凭据清理（`packages/desktop/test/sourceServerDirectory.test.ts`）。
- [x] 向导校验与目标构造（`packages/ui/test/remoteConnectionWizard.test.ts`、
      `remoteNewConnectionForm.test.ts`、`editConnectionProfileDialog.test.ts`）。
- [ ] 三平台真实 agent/默认密钥的端到端验收（沿用 SSH 测试容器方案，另排期）。
