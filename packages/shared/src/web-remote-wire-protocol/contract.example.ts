import {
  parseWebRemoteControlClientCapabilities,
  WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1,
} from "./contract.js";

export const encryptedRemoteCapabilitiesExample = parseWebRemoteControlClientCapabilities({
  codez_type: "client-capabilities",
  v: 1,
  caps: [WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1],
});
