import { z } from "zod";

const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isSecret: z.boolean().optional(),
  isOther: z.boolean().optional(),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .nullable()
    .optional(),
});
export type CodexQuestion = z.infer<typeof questionSchema>;
export function readCodexQuestions(input: unknown): CodexQuestion[] | null {
  const result = z.object({ questions: z.array(questionSchema).min(1) }).safeParse(input);
  return result.success ? result.data.questions : null;
}
export function codexQuestionAnswer(
  questions: CodexQuestion[],
  values: Record<string, string>,
): Record<string, string[]> | null {
  if (questions.some((question, index) => !values[String(index)]?.trim())) return null;
  // 原生 broker 按 id 或索引读取；不能沿用旧表单的 {answers:{questionText:...}} 包装。
  return Object.fromEntries(
    questions.map((question, index) => [question.id || String(index), [values[String(index)]!]]),
  );
}
