import type { CodezBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeCodezBackgroundTaskControlItems(
  current: readonly CodezBackgroundTaskControlItem[],
  updates: readonly CodezBackgroundTaskControlItem[],
): CodezBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
