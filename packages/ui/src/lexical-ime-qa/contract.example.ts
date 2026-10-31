import type { LexicalImeProbeObservation } from "./contract.js";

/** 合成验收数据，不挂载 editor 或发送真实任务。 */
export const composingProbeExample = {
  events: ["beforeinput:示例:insertCompositionText:true"],
  submitCount: 0,
  text: "示例",
} satisfies LexicalImeProbeObservation;
