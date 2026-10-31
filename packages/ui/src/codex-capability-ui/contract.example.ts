import type { CodexHelloPort } from "./contract.js";

/** UI 在自己的 scope guard 内接收结果；此端口不保存 hello 副本。 */
export function helloCapabilityExample(port: CodexHelloPort) {
  return port.helloConversationV4();
}
