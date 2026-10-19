/**
 * codex-model-trajectory 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import type { CodezModelTrajectory } from "#src/session/codezTaskService.js";

export interface CodexModelTrajectoryContract {
  /**
   * 从 Codex state sqlite / rollout JSONL 读取 taskId 的 per-turn 模型轨迹。
   * 只读、幂等、无事件；索引或 rollout 缺失时返回 available + empty。
   */
  read(taskId: string, limit?: number, env?: NodeJS.ProcessEnv): Promise<CodezModelTrajectory>;
}
