import { useMemo, useState } from "react";
import type { ICodezAgentService } from "@codez/services";
import { Button } from "@/components/ui/button.js";
import {
  isCodexMessageFeedbackAvailable,
  useCodexMessageFeedbackCapability,
} from "@/capabilities/useCodexMessageFeedbackCapability.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";

/** Exercise the shared row actions with the same surface gate as SessionPane. */
export function MessageFeedbackFixture() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [helloReads, setHelloReads] = useState(0);
  const [feedbackWrites, setFeedbackWrites] = useState(0);
  const agent = useMemo(
    () => ({
      helloConversationV4: async () => {
        setHelloReads((value) => value + 1);
        return {
          capabilities: { codex: { messageFeedback: "unsupported" } },
        } as Awaited<ReturnType<ICodezAgentService["helloConversationV4"]>>;
      },
    }),
    [],
  );
  const availability = useCodexMessageFeedbackCapability(
    agent,
    { workspacePath: "/isolated/workspace" },
    undefined,
    isDesktop,
  );
  return (
    <section data-testid="message-feedback-fixture">
      <Button onClick={() => setIsDesktop(true)}>Use Desktop feedback</Button>
      <Button onClick={() => setIsDesktop(false)}>Use Web feedback</Button>
      <output data-testid="feedback-hello-reads">{helloReads}</output>
      <output data-testid="feedback-writes">{feedbackWrites}</output>
      <ConversationAssistantTextActions
        rowId={9001}
        entityId="fixture-assistant-feedback"
        text="Fixture assistant response"
        createdAt={0}
        onFeedbackChange={
          isCodexMessageFeedbackAvailable(availability, isDesktop)
            ? () => {
                setFeedbackWrites((value) => value + 1);
                return true;
              }
            : undefined
        }
      />
    </section>
  );
}
