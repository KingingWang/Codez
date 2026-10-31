import { scopeModelSelectionServiceForAttachment } from "../modelSelectionAttachmentScope.js";
import type { ModelSelectionAttachmentAdapter } from "./contract.js";

/** 共享既有适配器，不另建 model catalog、revision 或配置 owner。 */
export const modelSelectionAttachmentExample: ModelSelectionAttachmentAdapter =
  scopeModelSelectionServiceForAttachment;
