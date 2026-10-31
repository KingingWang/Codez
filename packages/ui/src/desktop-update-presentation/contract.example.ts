import type { CodezProductFlavor, UpdateStatePayload } from "@codez/shared";
import type { DesktopUpdatePresentationContract } from "./contract.js";

/** 原生菜单和自绘菜单复用当前标签规则，不独立推断 updater 生命周期。 */
export function exampleDesktopUpdatePresentation(
  contract: DesktopUpdatePresentationContract,
  flavor: CodezProductFlavor,
  state: UpdateStatePayload | null,
) {
  return {
    visible: contract.shouldShowDesktopUpdateEntry(flavor),
    labelId: contract.getUpdateMenuLabelId(state),
    labelValues: contract.getUpdateMenuLabelValues(state),
  };
}
