import type { IFeedbackService } from "@codez/services";
import type { IPlatformService } from "@codez/shared";
import { memo } from "react";

/**
 * 反馈已统一改为直接打开本项目 GitHub Issues 预填页面，
 * 应用内不再渲染官方工单提交弹窗、产品需求弹窗、后台上传浮层或“我的反馈”列表。
 */
export const FeedbackHost = memo(function FeedbackHostComponent(_props: {
  feedbackService?: IFeedbackService;
  platform: IPlatformService;
}) {
  return null;
});
