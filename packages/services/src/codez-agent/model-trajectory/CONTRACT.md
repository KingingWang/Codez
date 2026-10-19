# codex-model-trajectory

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

意图：把 Codex 原生 rollout JSONL 投影为通用模型调用轨迹，供 Codez task facade 在 Codex runtime 下读取。

不变量：

- 只读、幂等，不写 Codex state/rollout，也不发布事件。
- rollout 解析优先走 `threads.rollout_path`；扫描兜底必须有界，并用 `session_meta.payload.id` 精确匹配 taskId。
- 内容读取复用 32 MiB 有界尾部；文件缺失、身份不匹配或只有未知事件时返回 `available:true, records:[]`。
- 记录是 per-turn 投影，不伪造完整原始 API request；`provider:"codex"` + sidecar source 防止 UI 套用 Codez Agent delta。

交集：task facade 负责按 Host runtime mode 路由；类型契约来自 session 的 `CodezModelTrajectory`。
