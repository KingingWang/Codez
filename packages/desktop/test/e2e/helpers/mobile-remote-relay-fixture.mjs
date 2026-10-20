import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

/** 仅供隔离浏览器测试的本地透传端点；不使用线上 relay 或任何真实设备凭据。 */
export async function createMobileRemoteRelayFixture() {
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const peers = new Map();
  const wire = [];
  relay.on("connection", (socket) => {
    let role;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "device_register_init") {
        socket.send(JSON.stringify({ type: "device_register_ack", device_sid: "sid-mobile-test" }));
      } else if (message.type === "auth_init") {
        role = message.role;
        peers.set(role, socket);
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "local-test-nonce" }));
      } else if (message.type === "auth_response" || message.type === "pair_status_query") {
        if (role === "terminal" && message.type === "auth_response") {
          peers
            .get("device")
            ?.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
        }
        socket.send(
          JSON.stringify({
            type: message.type === "auth_response" ? "auth_ack" : "pair_status_ack",
            device_sid: "sid-mobile-test",
            pair_status: peers.has("terminal") ? "matched" : "waiting",
          }),
        );
      } else if (message.type === "data") {
        wire.push({ role, type: message.payload.zcode_type });
        const peer = peers.get(role === "device" ? "terminal" : "device");
        if (peer?.readyState === WebSocket.OPEN) peer.send(raw.toString());
      }
    });
  });
  await once(relay, "listening");
  return { relay, wire, relayUrl: `ws://127.0.0.1:${relay.address().port}` };
}
