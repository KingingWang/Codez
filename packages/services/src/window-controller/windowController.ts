import type { Event } from "@codez/rpc";
import { ServiceChannels } from "@codez/shared";
import type { CodezTaskMeta } from "@codez/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@codez/shared/codez-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { CodezArchivedTaskDeletionResult } from "#src/session/codezTaskService.js";
import type {
  CodezTaskListItem,
  CodezTaskListQuery,
  CodezTaskListResult,
} from "../session/codezTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "rename"; title: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = CodezTaskListItem & {
  sourceServerId?: string;
  serverDisplayName?: string;
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<CodezTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/** 仅实时发送；列表快照与重同步不能重放一次完成提醒。 */
export interface WindowHostTaskUnreadSignal {
  address: WindowHostTaskAddress;
  updatedAt: number;
  status: "completed" | "error";
}

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<CodezArchivedTaskDeletionResult>;
  listTaskList(params: CodezTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  /** 直接读取所属 owner 的轻量 meta；未读 CAS 不得使用可能降级为旧快照的列表投影。 */
  getTaskMeta(params: { address: WindowHostTaskAddress }): Promise<CodezTaskMeta | null>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<CodezTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
  onDynamicTaskUnreadSignal(): Event<WindowHostTaskUnreadSignal>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
