import type { FeedbackEntryDiagnosticsPort } from "./contract.js";

/** 结果还须经过原唯一脱敏/限长收口，不直接拼接到对外 URL。 */
export function feedbackDeviceReadExample(port: FeedbackEntryDiagnosticsPort) {
  return port.getDeviceSnapshot();
}
