import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow, SubagentRow } from "@codez/shared/codez-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const mobile = query.get("mobile") === "true";
document.documentElement.className = `${theme} theme-zai-${theme}`;

const scenarios = [
  "completed",
  "running",
  "multiple",
  "paired",
  "missing-child",
  "missing-parent",
  "missing-opener",
  "late-child",
  "empty-title",
  "long-title",
] as const;
type Scenario = (typeof scenarios)[number];
type OpenRequest = Parameters<
  NonNullable<ConversationRowRenderContext["onOpenSubagentSession"]>
>[0];

const base = { turnId: "fixture-turn", createdAt: 1_700_000_000_000, createdAtSeq: 1 };
const childTitle = "E2E_CSNAV33 inspect activity-only history";
const longTitle = `E2E_CSNAV33_${"long-summary-without-whitespace-".repeat(7)}`.slice(0, 200);

function subagent(
  rowId: number,
  childSessionId: string | undefined,
  status: SubagentRow["status"],
  summaryText = childTitle,
): SubagentRow {
  return {
    ...base,
    rowId,
    kind: "subagent",
    subagentType: "subagent",
    status,
    summaryText,
    ...(childSessionId === undefined ? {} : { childSessionId }),
  };
}

function buildRows(scenario: Scenario, updated: boolean): ConversationRow[] {
  const status = scenario === "running" && !updated ? "running" : "success";
  const rows: ConversationRow[] = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "backgroundResult",
      state: status === "running" ? "running" : "completedSuccess",
      startedAt: base.createdAt,
      ...(status === "running" ? {} : { endedAt: base.createdAt + 1000 }),
    },
  ];
  if (scenario === "paired") {
    const description = "E2E_CSNAV33 paired spawn title";
    rows.push(
      {
        ...base,
        rowId: 10,
        kind: "toolCall",
        toolCallId: "fixture-spawn",
        toolName: "spawn_agent",
        status: "success",
        input: { description, prompt: "E2E_CSNAV33 prompt must remain collapsed" },
        inputText: "",
      },
      {
        ...subagent(11, "fixture-paired", "success", description),
        parentToolCallId: "fixture-spawn",
      },
    );
    return rows;
  }
  rows.push({
    ...base,
    rowId: 10,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: { type: "codexEvent", event: "subagentStarted", detail: "fixture/activity-only" },
  });
  const missingChild = scenario === "missing-child" || (scenario === "late-child" && !updated);
  rows.push(
    subagent(
      11,
      missingChild ? undefined : "fixture-child",
      status,
      scenario === "empty-title" ? "" : scenario === "long-title" ? longTitle : childTitle,
    ),
  );
  if (scenario === "multiple") {
    rows.push(subagent(12, "fixture-second", "failed", "E2E_CSNAV33 second child"));
    rows.push(subagent(13, "fixture-third", "cancelled", "E2E_CSNAV33 third child"));
  }
  return rows;
}

function Fixture() {
  const [scenario, setScenario] = useState<Scenario>("completed");
  const [updated, setUpdated] = useState(false);
  const [requests, setRequests] = useState<OpenRequest[]>([]);
  const rows = useMemo(() => buildRows(scenario, updated), [scenario, updated]);
  const recordOpen = useCallback((request: OpenRequest) => {
    setRequests((previous) => [...previous, request]);
  }, []);
  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      nativeCodex: true,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      rootSessionId: "fixture-root",
      sessionId: scenario === "missing-parent" ? undefined : "fixture-parent",
      theme,
      workspacePath: "/fixture",
      compactForRemoteControl: mobile,
      onOpenSubagentSession: scenario === "missing-opener" ? undefined : recordOpen,
    }),
    [scenario, recordOpen],
  );
  return (
    <TooltipProvider>
      <CodezIntlProvider initialLocale={locale}>
        <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
          <nav className="flex shrink-0 flex-wrap items-center gap-2 p-2 text-ui-sm">
            <label>
              Fixture scenario{" "}
              <select
                data-testid="fixture-scenario"
                value={scenario}
                onChange={(event) => {
                  setScenario(event.target.value as Scenario);
                  setUpdated(false);
                  setRequests([]);
                }}
              >
                {scenarios.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button data-testid="fixture-update" onClick={() => setUpdated(true)}>
              Update row
            </button>
          </nav>
          <div
            className="flex min-h-0 min-w-0 flex-1"
            data-testid="fixture-timeline"
            data-scenario={scenario}
          >
            <ConversationTimeline
              rows={rows}
              totalCount={rows.length}
              sessionKey={`fixture-parent-${scenario}`}
              scrollMemoryKey={`fixture::${scenario}`}
              compactForRemoteControl={mobile}
              rowContext={rowContext}
            />
          </div>
          <output className="sr-only" data-testid="fixture-requests">
            {JSON.stringify(requests)}
          </output>
        </div>
      </CodezIntlProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
