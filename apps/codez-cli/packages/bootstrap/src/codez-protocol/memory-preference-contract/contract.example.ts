import {
  applyHostMemoryPreferencesToRecord,
  type HostMemoryPreferences,
} from "./contract.js";

/** 保留 resident record 和原 runtime owner，由既有函数计算 effective 偏好。 */
export async function applyHostMemoryPreferencesExample(
  record: Parameters<typeof applyHostMemoryPreferencesToRecord>[0],
  preferences: HostMemoryPreferences,
): Promise<void> {
  await applyHostMemoryPreferencesToRecord(record, preferences);
}
