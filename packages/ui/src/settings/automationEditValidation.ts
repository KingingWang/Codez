export type AutomationEditRequiredField = "title" | "schedule" | "prompt";

export function resolveAutomationEditRequiredFieldErrors(params: {
  title: string;
  cronExpr: string;
  prompt: string;
}): AutomationEditRequiredField[] {
  const errors: AutomationEditRequiredField[] = [];
  if (!params.title.trim()) errors.push("title");
  if (!params.cronExpr.trim()) errors.push("schedule");
  if (!params.prompt.trim()) errors.push("prompt");
  return errors;
}

export function isAutomationEditSubmissionContextReady(params: {
  workspaceSelected: boolean;
  modelViewReady: boolean;
  selectedModelValue: string;
  selectionIssue?: string;
}): boolean {
  // 修复：Codex 自定义默认模型可不在发现目录中、也可没有 reasoningLevel；
  // 只相信目标 Host 校验后的有效模型，不要求菜单条目或伪造原生档位。
  return (
    params.workspaceSelected &&
    params.modelViewReady &&
    Boolean(params.selectedModelValue) &&
    !params.selectionIssue
  );
}

/** 正常编辑只撤销当前字段已有的提交告警，不主动产生新的告警。 */
export function clearAutomationEditRequiredFieldError(
  errors: ReadonlySet<AutomationEditRequiredField>,
  field: AutomationEditRequiredField,
): ReadonlySet<AutomationEditRequiredField> {
  if (!errors.has(field)) return errors;
  const next = new Set(errors);
  next.delete(field);
  return next;
}
