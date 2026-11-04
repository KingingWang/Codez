import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@codez/shared";
import type { CodexServerRequest } from "./contract.js";

export interface QuestionAutoResolutionOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  hiddenGraceMs?: number;
  autoResolutionMs?: number;
  onError?: (error: unknown) => void;
  /** 只读 live 历史观察；答案只在原生写回成功后提供，不承接持久化。 */
  onQuestion?: (request: CodexServerRequest, response?: unknown) => void;
}

export const QUESTION_HIDDEN_GRACE_MS = 60_000;
export const QUESTION_AUTO_RESOLUTION_MS = 300_000;

export function scheduleQuestionTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export function resolveQuestionAutoResolutionOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): Pick<QuestionAutoResolutionOptions, "hiddenGraceMs" | "autoResolutionMs"> | undefined {
  // 生产必须使用完整窗口，不能让测试加速变量改变真实用户的回答期限。
  const raw = env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV];
  if (env.CODEZ_ENV !== "test" || !raw) return;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 1 || scale > 1000)
    throw new Error("Question clock scale must be between 1 and 1000");
  return {
    hiddenGraceMs: QUESTION_HIDDEN_GRACE_MS / scale,
    autoResolutionMs: QUESTION_AUTO_RESOLUTION_MS / scale,
  };
}
