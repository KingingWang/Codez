import { crc32, deflateSync } from "node:zlib";
import { createServer } from "node:http";

export function pixelPng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createSmokeModelServer({ reuseItemId = false } = {}) {
  let requestCount = 0;
  const server = createServer((req, res) => {
    req.resume();
    requestCount += 1;
    const item = {
      // 默认保留原始 unique-ID 控制组；opt-in 复用真实协议允许的跨 turn item ID。
      id: reuseItemId ? "msg_reused_across_turns" : `msg_${requestCount}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Bridge smoke response", annotations: [] }],
    };
    const response = {
      id: `resp_${requestCount}`,
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
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Bridge smoke response",
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: "Bridge smoke response",
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  return { server, requests: () => requestCount };
}
