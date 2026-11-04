import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { resolveDesktopRuntimePreferences } from "@/settings/codex/codexRuntimePreferences.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
document.documentElement.className = `${theme} theme-zai-${theme}`;
declare global {
  interface Window {
    questionFixtureRefresh(): Promise<void>;
  }
}

function Fixture() {
  const { intl } = useCodezIntl();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch("/question-fixture/state");
    if (!response.ok) throw new Error("Fixture state failed");
    setSnapshot((await response.json()).snapshot);
  }, []);
  useEffect(() => {
    window.questionFixtureRefresh = refresh;
    void refresh();
  }, [refresh]);
  const sendCommand = useCallback(
    async (envelope: CommandEnvelope) => {
      const response = await fetch("/question-fixture/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw new Error("Fixture command failed");
      const ack = await response.json();
      await refresh();
      return ack;
    },
    [refresh],
  );
  const conversation = useMemo(
    () => ({ sendCommand }) as V4ConversationContextValue,
    [sendCommand],
  );
  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      nativeCodex: true,
      rootSessionId: "fixture-thread",
      sessionId: "fixture-thread",
      theme,
      workspacePath: "/workspace",
      compactForRemoteControl: query.get("mobile") === "true",
      messageStreamShowReasoning: true,
      messageStreamShowTodos: true,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [],
  );
  const pending = snapshot?.pendingInteractions[0];
  const preferences = resolveDesktopRuntimePreferences(
    {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: true,
    },
    true,
  );
  return (
    <V4ConversationContext.Provider value={conversation}>
      <main className="flex h-dvh min-w-0 flex-col gap-2 bg-background p-4 text-foreground">
        <h1 className="text-ui-lg">E2E_CSAQ34 native question acceptance</h1>
        <output className="break-all text-ui-xs" data-testid="fixture-preferences">
          {JSON.stringify(preferences)}
        </output>
        <div data-testid="fixture-badge">
          <TaskInteractionBadge
            interaction={
              pending && {
                interactionId: pending.interactionId,
                kind: pending.kind === "userInput" ? "userInput" : "permission",
                toolName:
                  pending.payload.kind === "workspaceHookReview"
                    ? undefined
                    : pending.payload.toolName,
                autoResolution: pending.autoResolution,
              }
            }
            formatMessage={(id) => intl.formatMessage({ id })}
            onSnoozeCountdown={(interactionId) =>
              sendInteractionAutoResolutionSnooze({
                sessionId: "fixture-thread",
                interactionId,
                sendCommand,
                source: "taskBadge",
              })
            }
          />
        </div>
        {snapshot && (
          <>
            <div className="min-h-0 min-w-0 flex-1">
              <ConversationTimeline
                rows={snapshot.rows.window}
                totalCount={snapshot.rows.totalCount}
                sessionKey={snapshot.sessionId}
                rowContext={rowContext}
                compactForRemoteControl={query.get("mobile") === "true"}
              />
            </div>
            <V4InteractionDialogs
              sessionId={snapshot.sessionId}
              workspacePath="/workspace"
              isWebRemoteControl={query.get("mobile") === "true"}
              snapshot={snapshot}
            />
          </>
        )}
      </main>
    </V4ConversationContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <CodezIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </CodezIntlProvider>,
);
