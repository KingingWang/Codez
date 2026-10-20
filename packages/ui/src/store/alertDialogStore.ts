import { create } from "zustand";
import { logger } from "@/logger.js";

export interface AlertDialogRequest {
  title: string;
  description?: string;
  actionLabel?: string;
}

interface PendingAlertDialogRequest extends AlertDialogRequest {
  resolve: (confirmed: boolean) => void;
}

interface AlertDialogState {
  pendingRequest?: PendingAlertDialogRequest;
  requestAlert: (payload: AlertDialogRequest, signal?: AbortSignal) => Promise<boolean>;
  settleAlert: (confirmed?: boolean) => void;
}

export const useAlertDialogStore = create<AlertDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestAlert: (payload, signal) => {
    if (signal?.aborted) return Promise.resolve(false);
    if (get().pendingRequest) {
      logger.warn("[AlertDialogStore] alert already in progress");
      // 并发请求不会复用已有弹窗；返回 false 让破坏性动作（如重启）保持未确认状态。
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const pendingRequest: PendingAlertDialogRequest = {
        ...payload,
        resolve: (confirmed) => {
          signal?.removeEventListener("abort", cancelOwnedPrompt);
          resolve(confirmed);
        },
      };
      const cancelOwnedPrompt = () => {
        // 旧 Host 只撤销自己的提示；如果用户已处理它，不可误关后来的无关确认框。
        if (get().pendingRequest !== pendingRequest) return;
        set({ pendingRequest: undefined });
        pendingRequest.resolve(false);
      };
      signal?.addEventListener("abort", cancelOwnedPrompt, { once: true });
      set({ pendingRequest });
      if (signal?.aborted) cancelOwnedPrompt();
    });
  },
  settleAlert: (confirmed = true) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(confirmed);
  },
}));
