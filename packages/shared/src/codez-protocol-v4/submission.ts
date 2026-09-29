import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。
 * custom 仅 Codex 链路使用（跟随 config.toml 权限），Codez Agent 运行时不产生该值。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "custom"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
