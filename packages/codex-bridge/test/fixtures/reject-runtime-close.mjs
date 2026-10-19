// Fault injection is confined to a test child, never a production environment flag.
import { BridgeRuntime } from "../../src/bridge-runtime.ts";
const close = BridgeRuntime.prototype.close;
BridgeRuntime.prototype.close = async function () {
  await close.call(this);
  throw new Error("synthetic-secret /Users/private shutdown-content");
};
