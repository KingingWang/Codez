# Native producer

Helper 中的 `createXa11yProducer` 是 native single-flight、输入位置、snapshot/baseline、
启动合并和销毁状态的唯一 owner。协议解析、native 观察投影、应用解析只读取该 factory
的端口，不持有第二份 maps、权限结论、队列或 lifecycle。

14 个 wire method、严格参数校验、state/frame/window 身份和输入前台门保持不变。
已下发动作的错误保留 actionSent；dispose 与 native await 竞态仍拒绝晚完成。
原顶层 exports 与 driver seam 保持兼容，产品入口不会回退为本机 driver。
