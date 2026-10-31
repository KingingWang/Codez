import type { Xa11yProducer, Xa11yProducerContext } from "./contract.js";

/** 注入已有 producer；示例不会创建原生驱动或新的会话状态。 */
export async function observeAppsExample(
  producer: Xa11yProducer,
  context: Xa11yProducerContext,
): Promise<unknown> {
  return producer.dispatch("list_apps", {}, context);
}
