import { array, object, type JsonObject } from "./json.js";

/** turn/plan/updated 的合成 item id 由 bridge 拥有；原生 item id 是原生生成的标识，不会取这个固定值。 */
const PLAN_UPDATE_ITEM_ID = "plan-update";

/** 原生 v2 通知使用 camelCase 状态；投影层统一为 UI 计划词表（pending/in_progress/completed）。 */
function normalizePlanStepStatus(value: unknown): "pending" | "in_progress" | "completed" | null {
  if (value === "pending" || value === "completed") return value;
  if (value === "inProgress" || value === "in_progress") return "in_progress";
  return null;
}

/**
 * update_plan 通知是全量替换语义：同一 turn 只保留一张计划卡，原位更新保持首次出现的位置。
 * 载荷来自模型输出，必须防御性解析——任何不可用内容只丢这张卡，绝不让串行事件尾巴失败。
 */
export function upsertTurnPlanUpdate(turn: JsonObject, params: JsonObject): void {
  const steps: { step: string; status: "pending" | "in_progress" | "completed" }[] = [];
  for (const raw of array(params.plan)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const status = normalizePlanStepStatus(record.status);
    const title = typeof record.step === "string" ? record.step.trim() : "";
    if (!title || !status) continue;
    steps.push({ step: title, status });
  }
  if (steps.length === 0) return;
  const item: JsonObject = { id: PLAN_UPDATE_ITEM_ID, type: "planUpdate", plan: steps };
  if (typeof params.explanation === "string" && params.explanation.trim().length > 0)
    item.explanation = params.explanation;
  const items = array(turn.items);
  const index = items.findIndex(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as JsonObject).id === PLAN_UPDATE_ITEM_ID,
  );
  if (index < 0) items.push(item);
  else items[index] = item;
  turn.items = items;
}
