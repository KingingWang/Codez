export type { PipSessionEvent, PipSessionSnapshot } from "../pip-session.js";

export interface CuaPipApplyResult {
  applied: boolean;
  reason?: string;
}

export interface CuaPipCapture {
  sessionId: string;
  turnId: string;
  frameId: string;
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
  title?: string;
}

/** 所有命令交给同一 coordinator，调用方不保存 presentation state。 */
export interface CuaPipCoordinatorContract {
  applySnapshot(snapshot: unknown): Promise<CuaPipApplyResult>;
  applyEvent(event: unknown): Promise<CuaPipApplyResult>;
  bindCapture(capture: unknown): Promise<{
    accepted: boolean;
    pending?: boolean;
    reason?: string;
  }>;
  dispose(): Promise<void>;
}

export interface CuaPipPresenterContract {
  show(capture: CuaPipCapture): Promise<void>;
  hide(): Promise<void>;
  dispose(): Promise<void>;
}
