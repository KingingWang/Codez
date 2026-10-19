/**
 * codex-model-trajectory 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { CodexModelTrajectoryContract } from "./contract.js";

export async function exampleCodexModelTrajectory(
  contract: CodexModelTrajectoryContract,
): Promise<void> {
  await contract.read("codex-session-id", 200);
}
