import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Case-local Responses fixture: native request_user_input is executed by the real pinned Codex. */
export function createQuestionAutoResolutionModel() {
  const requests = [],
    continuations = [],
    errors = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const index = ++sequence;
      const response = {
        id: `resp_${index}`,
        object: "response",
        status: "in_progress",
        output: [],
      };
      const tools = (body.tools ?? []).flatMap((tool) =>
        tool.type === "namespace"
          ? (tool.tools ?? []).map((child) => ({ ...child, namespace: tool.name }))
          : [tool],
      );
      const nativeQuestion = tools.find(
        (tool) => tool.name === "request_user_input" || tool.name?.endsWith("__request_user_input"),
      );
      const result = (body.input ?? []).findLast(
        (item) => item.type === "function_call_output" && item.call_id?.startsWith("question_"),
      );
      let output;
      if (result) {
        continuations.push(result);
        output = [
          {
            id: `msg_${index}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "E2E_CSAQ34 native continued", annotations: [] },
            ],
          },
        ];
      } else {
        assert.ok(
          nativeQuestion,
          "pinned Codex must advertise ordinary request_user_input in plan collaboration",
        );
        output = [
          {
            id: `question_${index}`,
            type: "function_call",
            status: "completed",
            call_id: `question_${index}`,
            name: nativeQuestion.name,
            ...(nativeQuestion.namespace ? { namespace: nativeQuestion.namespace } : {}),
            arguments: JSON.stringify({
              questions: [
                {
                  id: "target",
                  header: "Target",
                  question: "E2E_CSAQ34 Which isolated target?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "Staging", description: "Isolated" },
                    { label: "Production", description: "Not selected automatically" },
                  ],
                },
              ],
            }),
          },
        ];
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      event("response.created", { response });
      output.forEach((item, output_index) =>
        event("response.output_item.done", { output_index, item }),
      );
      event("response.completed", {
        response: {
          ...response,
          status: "completed",
          output,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    } catch (error) {
      errors.push(error.message);
      res.destroy(error);
    }
  });
  return { server, requests, continuations, errors };
}
