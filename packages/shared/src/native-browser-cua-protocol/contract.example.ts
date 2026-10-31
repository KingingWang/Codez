import { nativeBrowserCuaMcpStatusSchema } from "./contract.js";

export const nativeControlUnavailableExample = nativeBrowserCuaMcpStatusSchema.parse({
  browser: false,
  cua: false,
  cuaReason: "runtime-unavailable",
});
