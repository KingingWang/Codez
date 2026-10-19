import type {
  SourceServerResolveWorkspaceRequest,
  SourceServerResolveWorkspaceResult,
  SourceServerMigrationPathAction,
  SourceServerMigrationReport,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISourceServerWorkspaceService {
  resolveWorkspace(
    request: SourceServerResolveWorkspaceRequest,
  ): Promise<SourceServerResolveWorkspaceResult>;
  getFailedPathCount(): Promise<number>;
  getAbandonedPathCount(): Promise<number>;
  listMigrationReports(): Promise<SourceServerMigrationReport>;
  abandonFailedWorkspace(request: SourceServerMigrationPathAction): Promise<SourceServerMigrationReport>;
  retryWorkspaceMigration(request: SourceServerMigrationPathAction): Promise<SourceServerMigrationReport>;
}

export const ISourceServerWorkspaceService = createServiceDescriptor<ISourceServerWorkspaceService>(
  ServiceChannels.SourceServerWorkspace,
);
