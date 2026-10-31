import type { DynamicWorkflowAvailabilitySnapshot } from "./contract.js";

/** 消费方只接收同一只读快照；取数和用户设置同步由 Root 的既有 hooks 负责。 */
export function exampleDynamicWorkflowAvailability(
  snapshot: DynamicWorkflowAvailabilitySnapshot,
): boolean {
  return snapshot.status === "ready" && snapshot.enabled;
}
