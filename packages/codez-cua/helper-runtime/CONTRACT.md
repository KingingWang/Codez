# Helper runtime

原 Helper factory 唯一持有 credential tuple、socket/PiP handle、shutdown promise 与 idle
timer；先 IPC challenge 并核对 pid/nonce/generation，再加载 native、preflight、bind 和 ready。
native-access 与 result-projection 是无常驻状态的适配器。

完整 broker 帧按字节校验后解码；未知方法、坏凭据、旧 generation 与超限 fail closed。
shutdown 先返回认证 ACK，再按原事件顺序回收。同一 backend 保持串行执行及幂等 dispose。
公开 runtime 只走 Helper，不增加 driver fallback、权限缓存或 mutation 重放。
