# Codex 远端制品与安装适配

精确登记 remote 下的 bundledRemoteAssets、codexReleaseRemoteAssets、
codexFallbackInstaller、codexRuntimeDeploy 与 remoteRuntime；不接管整个 remote 目录。
本模块为 adapters，复用既有 server 的 backend、installer、manifest、网络和原子发布端口。
contract 中的类型直接取现有工厂/命令签名，不创建另一套安装 API 或缓存 owner。

固定的打包 index 决定 releaseTag、目标及 SHA；同一 source closure 的 snapshotPromise
与既有 in-flight map 合并读取/下载。每条连接独占 fallback 决策，两个 installer 仍消费
同一 pinned manifest。下载失败不绕过终态内容、目标、路径或必需文件校验。

```text
pinned index → tag / target / SHA → existing source → verified staging
                                                   → existing installer
                                                   → verify files → write identity
```

native 与 bridge 保留独立 component identity；失败或取消不得发布成功身份。
数据根只由既有 runtime layout 解析，不能写原生 CODEX_HOME 或把会话状态放到制品缓存。
不会新增 SSH 连接、Host、Agent 或重放任务。

依据：[Codex 分发](../../../../specs/codex-desktop-distribution.md)、
[统一分发](../../../../specs/codez-unified-distribution.md)、
[上游集成](../../../../specs/upstream-main-integration.md)。
