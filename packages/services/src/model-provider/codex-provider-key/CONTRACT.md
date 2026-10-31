# Codex provider key

登记原 source key writer、native workspace key service 和 spawn environment 投影。
source 凭据、native 配置以及 UI 保存意图继续归各自原 owner，不新建全局 Key 真值副本。

```text
原 workspace writeTarget → prepareKeySource / 既有屏障
                                    ↓
                              原 config 写入
                                    ↓
                  finishKeySource(commit/rollback) → 原 runtime 安装/释放
```

- Renderer 读取只返回 configured/envName，不返回 Key；日志、例子和快照不包含凭据。
- runtime-env、config-file、delete 继续使用原两阶段事务；缺省 apiKey 保留原凭据。
- source 写入复用原 provider provisioning/credential port，不另造 config 或 credential writer。
- 保存资格由原 workspace/identity writeTarget 决定，不把 Agent 代际加入写目标。
- deferredRuntimeRestarts、errorTarget 及真实 workspace 切换失效仍由现有调用方/Host mutation owner 处理。
- credential/env registry、在线连接安装和失败 rollback 保留原顺序；同一保存中的 rotation restart 不使结果失效。
- SSH/WSL/Docker 和本地环境沿用原服务装配差异，登记不扩大 Server remote 的 Key 管理权限。
