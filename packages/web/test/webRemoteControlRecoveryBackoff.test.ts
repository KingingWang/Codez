import { describe, expect, it } from "vitest";
import {
  BRIDGE_DEGRADATION_BACKOFF_MAX_DELAY_MS,
  BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS,
  BRIDGE_DEGRADATION_BACKOFF_WINDOW_MS,
  createWebRemoteControlRecoveryBackoff,
} from "../src/webRemoteControlRecoveryBackoff.js";

describe("createWebRemoteControlRecoveryBackoff", () => {
  it("前两次降级立即恢复，第三次起按 5s/10s/20s/30s 封顶退避", () => {
    let now = 1_000_000;
    const backoff = createWebRemoteControlRecoveryBackoff(() => now);
    expect(backoff.noteDegradation()).toBe(0);
    now += 12_000;
    expect(backoff.noteDegradation()).toBe(0);
    now += 12_000;
    expect(backoff.noteDegradation()).toBe(BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS);
    now += 12_000;
    expect(backoff.noteDegradation()).toBe(BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS * 2);
    now += 12_000;
    expect(backoff.noteDegradation()).toBe(BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS * 4);
    now += 12_000;
    expect(backoff.noteDegradation()).toBe(BRIDGE_DEGRADATION_BACKOFF_MAX_DELAY_MS);
    now += 12_000;
    // 继续降级不再增长，封顶 30s。
    expect(backoff.noteDegradation()).toBe(BRIDGE_DEGRADATION_BACKOFF_MAX_DELAY_MS);
  });

  it("窗口外的旧降级不计入：稳定运行 120s 后再次降级视为首次", () => {
    let now = 1_000_000;
    const backoff = createWebRemoteControlRecoveryBackoff(() => now);
    backoff.noteDegradation();
    backoff.noteDegradation();
    now += BRIDGE_DEGRADATION_BACKOFF_WINDOW_MS + 1;
    expect(backoff.noteDegradation()).toBe(0);
  });

  it("reset 清零计数（用户生命周期恢复后按最快路径）", () => {
    let now = 1_000_000;
    const backoff = createWebRemoteControlRecoveryBackoff(() => now);
    backoff.noteDegradation();
    backoff.noteDegradation();
    backoff.noteDegradation();
    backoff.reset();
    now += 1_000;
    expect(backoff.noteDegradation()).toBe(0);
  });
});
