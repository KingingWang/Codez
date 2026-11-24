import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type CodezProvider,
  type FeedbackTicketFramework,
} from "@codez/shared";

export function inferFeedbackFrameworkFromAgentProvider(
  _provider: CodezProvider | null | undefined,
): FeedbackTicketFramework {
  return DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
}
