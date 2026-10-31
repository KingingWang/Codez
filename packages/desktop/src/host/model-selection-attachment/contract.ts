import type { CodezAgentV4ClientMode, IModelSelectionService } from "@codez/services";
import type { WindowHostAttachmentScope } from "@codez/shared";

/** 模型、配置与 revision 仍由原 service 持有；attachment 只限定请求/事件目标。 */
export type ModelSelectionAttachmentAdapter = (
  service: IModelSelectionService,
  clientMode: CodezAgentV4ClientMode,
  scope: WindowHostAttachmentScope,
) => IModelSelectionService;
