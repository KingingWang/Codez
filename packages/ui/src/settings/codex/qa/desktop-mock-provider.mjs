// Loopback-only deterministic provider for the isolated desktop probe. No tools or credentials.
import { createServer } from "node:http";
import { once } from "node:events";

export async function startDesktopMockProvider({ reuseItemId = false } = {}) {
  const requests = [];
  const pending = new Set();
  const completed = [];
  const interrupted = [];
  let hold = true;
  const server = createServer(async (req, res) => {
    if (req.url === "/qa" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ requests, pending: pending.size, hold, completed, interrupted }));
      return;
    }
    if (req.url === "/qa/hold" && req.method === "POST") {
      hold = true;
      res.end("held");
      return;
    }
    if (req.url === "/qa/release" && req.method === "POST") {
      hold = false;
      for (const finish of pending) finish();
      pending.clear();
      res.end("released");
      return;
    }
    if (req.url !== "/v1/responses" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2_000_000) throw new Error("QA request too large");
      }
      const input = JSON.parse(body);
      const images = (input.input ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "input_image");
      // Store only fixture diagnostics, not native system prompts or credentials.
      requests.push({
        model: input.model,
        imageCount: images.length,
        imageIsDataUrl: images.every((image) => image.image_url?.startsWith("data:image/")),
      });
      const index = requests.length;
      const text = `Isolated desktop QA response ${index}`;
      const item = {
        // 兼容性回归：部分 provider 在不同轮次复用消息 ID，不能导致桌面第二轮退出。
        id: reuseItemId ? "msg_qa_reused" : `msg_qa_${index}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const response = {
        id: `resp_qa_${index}`,
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          total_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      send({
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      });
      const finish = () => {
        if (res.destroyed || res.writableEnded) return;
        send({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        send({
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        send({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text,
        });
        send({ type: "response.output_item.done", output_index: 0, item });
        send({ type: "response.completed", response });
        completed.push(index);
        res.end();
        pending.delete(finish);
      };
      if (hold) pending.add(finish);
      else finish();
      res.on("close", () => {
        if (!res.writableEnded) interrupted.push(index);
        pending.delete(finish);
      });
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
