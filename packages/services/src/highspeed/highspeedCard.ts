import type {
  HighspeedCardUsage,
  HighspeedPrepareTurnParams,
  HighspeedPrepareTurnResult,
  HighspeedServiceSnapshot,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHighspeedCardService {
  prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult>;
  getSnapshot(): Promise<HighspeedServiceSnapshot>;
  healthy(cardId: string): Promise<HighspeedCardUsage>;
}

export const IHighspeedCardService = createServiceDescriptor<IHighspeedCardService>(
  ServiceChannels.HighspeedCard,
);
