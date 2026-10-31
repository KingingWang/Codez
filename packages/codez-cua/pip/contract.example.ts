import type { CuaPipCoordinatorContract, PipSessionEvent, PipSessionSnapshot } from "./contract.js";

/** 已认证的原 Host 事实进入同一 coordinator，不在调用方复制焦点或轮次。 */
export async function applyPipFactsExample(
  coordinator: CuaPipCoordinatorContract,
  snapshot: PipSessionSnapshot,
  event: PipSessionEvent,
): Promise<void> {
  await coordinator.applySnapshot(snapshot);
  await coordinator.applyEvent(event);
}
