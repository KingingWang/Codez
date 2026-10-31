/** 原隔离页面 probe 的只读观察面；它不是产品会话状态。 */
export interface LexicalImeProbeObservation {
  readonly events: readonly string[];
  readonly submitCount: number;
  readonly text: string;
}
