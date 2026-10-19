import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { assertQaCdpPortAvailable } from "./desktop-probe-ports.mjs";

test("isolated QA refuses a port already owned by any local CDP listener", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await assert.rejects(
      assertQaCdpPortAvailable(port),
      /already in use.*CDP.*different port|CDP.*already in use/i,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
  await assert.doesNotReject(assertQaCdpPortAvailable(port));
});
