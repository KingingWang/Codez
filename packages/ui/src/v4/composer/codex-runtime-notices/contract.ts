import type { RuntimeNotice } from "@codez/shared/codez-protocol-v4";

export interface CodexRuntimeNoticesProps {
  /** 同一份 V4 snapshot 的运行期通知；组件只投影，不修改、持久化或重发请求。 */
  notices: readonly RuntimeNotice[];
}
