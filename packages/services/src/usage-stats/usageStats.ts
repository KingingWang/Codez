import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CodexUsageCacheSnapshot } from "./codexUsageObservationCache.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodexUsageObservations(request: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<CodexUsageCacheSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
