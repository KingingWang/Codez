import { codezProtocolMethods, codezRuntimeCapabilitiesSchema } from "@codez/shared";
import type { CodezProtocolClient } from "./codezProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<CodezProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(codezProtocolMethods.runtimeCapabilities, {}, codezRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}

const historyChecks = new WeakMap<object, Promise<boolean>>();
/** 远端旧 CLI 的 strict subscribe 不接受新字段，能力确认后才转发。 */
export function supportsHistoryFirst(
  client: Pick<CodezProtocolClient, "request">,
): Promise<boolean> {
  const existing = historyChecks.get(client);
  if (existing) return existing;
  const check = client
    .request(codezProtocolMethods.runtimeCapabilities, {}, codezRuntimeCapabilitiesSchema)
    .then((result) => result.historyFirst === true)
    .catch(() => {
      historyChecks.delete(client);
      return false;
    });
  historyChecks.set(client, check);
  return check;
}
