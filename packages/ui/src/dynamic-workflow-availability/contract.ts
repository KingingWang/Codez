import type * as Availability from "@/hooks/useDynamicWorkflowAvailability.js";

/** Host 裁决后的只读投影；不是独立的工作流或配置 owner。 */
export type DynamicWorkflowAvailabilitySnapshot = ReturnType<
  typeof Availability.useDynamicWorkflowAvailability
>;

export interface DynamicWorkflowAvailabilityContract {
  readonly useAvailability: typeof Availability.useDynamicWorkflowAvailability;
  readonly useRootLoader: typeof Availability.useDynamicWorkflowAvailabilityLoader;
  readonly useUserModeSync: typeof Availability.useDynamicWorkflowUserModeSync;
}
