# Codex model selection

native config/model catalog 是事实源；现有 Host model-selection service 拥有
每 workspace 的在途读取、TTL 和 revision。本模块只登记现有应用端口及 pure catalog helper。

```text
workspace + identity → 原 single-flight owner → config/read + model/list
                                    ↑                    ↓
                         同一 scoped revision ← 原 catalog 投影
```

- 请求携带 workspacePath 与 identity；key 为 identity-or-path，不跨 Host/工作区复用缓存。
- 无 workspace 的旧读取保持空视图，不把当前 tab 当作隐式目标。
- catalog read port 仍由 Host 注入；本模块不启动第二个 runtime/provider registry 或自行读取配置文件。
- pagination 保留原 cursor 去重/上限；失败不制造模型或 reasoning effort 默认值。
- 同 workspace 并发读取继续合并；revision/event 必须带来源 workspace，dispose 保持原失效边界。
- 应用编排可使用 pure catalog helper，但整模块不是 domain；native 执行不反向读取这个 UI/read model。
- Automation、Bot 和移动 Web 沿用同一个所属 Host 的既有 model-selection 端口。
