import type { CodexThread } from "../src/codex-types.js";

// Executable projection specification for specs/codex-desktop-adapter.md cases 3/5/7/9.
// Only fields consumed by the bridge are narrowed; Codex remains the state owner.
export function threadFixture(): CodexThread {
  return {
    id: "thread-1",
    preview: "Hello",
    name: null,
    modelProvider: "openai",
    model: "fixture-model",
    reasoningEffort: "medium",
    cwd: "/workspace",
    createdAt: 100,
    updatedAt: 120,
    status: { type: "idle" },
    turns: [
      {
        id: "turn-1",
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 101,
        completedAt: 119,
        durationMs: 18000,
        items: [
          {
            type: "userMessage",
            id: "user-1",
            clientId: "command-1",
            content: [{ type: "text", text: "Hello", text_elements: [] }],
          },
          { type: "reasoning", id: "reason-1", summary: ["Consider"], content: ["Details"] },
          { type: "agentMessage", id: "answer-1", text: "Hello back", phase: "final_answer" },
        ],
      },
    ],
  };
}
