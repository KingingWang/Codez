import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useCodexMessages } from "./messages.js";
import { codexQuestionAnswer, type CodexQuestion } from "./codexQuestions.js";

export function CodexQuestionDialog({
  questions,
  onRespond,
}: {
  questions: CodexQuestion[];
  onRespond(answer: {
    action: "accept" | "cancel";
    content?: Record<string, string[]>;
  }): Promise<boolean>;
}) {
  const text = useCodexMessages();
  // 原生 secret 问答只驻留当前组件，不进入持久化的旧 elicitation draft store。
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const flight = useRef(false);
  const content = codexQuestionAnswer(questions, values);
  const respond = async (cancel: boolean) => {
    if (flight.current || (!cancel && !content)) return;
    flight.current = true;
    setPending(true);
    setFailed(false);
    try {
      const ok = await onRespond(
        cancel ? { action: "cancel" } : { action: "accept", content: content! },
      );
      setAccepted(ok);
      if (ok) setValues({});
      setFailed(!ok);
    } catch {
      setFailed(true);
    } finally {
      flight.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog
      open={!accepted}
      onOpenChange={(open) => {
        if (!open) void respond(true);
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogTitle>{text.questions}</DialogTitle>
        <DialogDescription>{text.questionsHelp}</DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void respond(false);
          }}
          className="space-y-4"
        >
          {questions.map((question, index) => (
            <fieldset key={`${index}:${question.id}`} disabled={pending} className="space-y-2">
              <legend className="text-ui-base font-medium">
                {question.header}: {question.question}
              </legend>
              {question.options?.map((option) => (
                <Button
                  type="button"
                  key={option.label}
                  variant={values[String(index)] === option.label ? "secondary" : "outline"}
                  className="mr-2 h-auto whitespace-normal text-left"
                  onClick={() => setValues((current) => ({ ...current, [index]: option.label }))}
                >
                  {option.label}
                  {option.description ? ` — ${option.description}` : ""}
                </Button>
              ))}
              <Input
                aria-label={question.question}
                type={question.isSecret ? "password" : "text"}
                autoComplete="off"
                value={values[String(index)] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [index]: event.target.value }))
                }
              />
            </fieldset>
          ))}
          {failed && (
            <p role="alert" className="text-ui-sm text-destructive">
              {text.failed}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void respond(true)}
            >
              {text.cancelAction}
            </Button>
            <Button type="submit" disabled={pending || !content}>
              {pending ? text.loading : text.submitAnswers}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
