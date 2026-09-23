import {
  collectVisibleCodezBackgroundTaskControlItems,
  getCodezBackgroundTaskControlItemElapsedMs,
  isActiveCodezBackgroundTaskControlItem,
  parseCodezBackgroundTaskControlItems,
  type CodezBackgroundTaskControlItem,
  type CodezBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type CodezBackgroundBashJobStatus = CodezBackgroundTaskControlStatus;
export type CodezBackgroundBashJob = CodezBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseCodezBackgroundBashJobs(value: unknown): CodezBackgroundBashJob[] {
  return parseCodezBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveCodezBackgroundBashJob(job: CodezBackgroundBashJob): boolean {
  return isActiveCodezBackgroundTaskControlItem(job);
}

export function getCodezBackgroundBashJobElapsedMs(
  job: CodezBackgroundBashJob,
  now = Date.now(),
): number {
  return getCodezBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleCodezBackgroundBashJobs(
  jobs: readonly CodezBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<CodezBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleCodezBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    CodezBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: CodezBackgroundTaskControlItem): job is CodezBackgroundBashJob {
  return job.taskKind === "bash";
}
