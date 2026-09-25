import { z } from "zod";
import { browserCommandSchema } from "./commands.js";
import { browserCommandResultSchema } from "./result.js";

export const CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME = "codez-desktop-browser-cua";
export const CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE = "native-browser-cua-mcp";
export const CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV = "CODEZ_NATIVE_BROWSER_CUA_ENDPOINT";
export const CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV = "CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE";
export const CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV = "CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE";
export const CODEZ_NATIVE_BROWSER_CUA_CUA_ENV = "CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE";
export const CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX = "codez-native-browser-cua";
export const CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON = "codez-cua.runtime_unavailable";
export const NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS = [
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "cuaKeypress",
  "scroll",
  "cuaScroll",
  "domCuaScroll",
  "hover",
  "select",
  "check",
  "drag",
  "cuaDrag",
  "screenshot",
  "getState",
  "elementInfo",
  "getDialog",
  "handleDialog",
  "waitFor",
] as const;
export const nativeBrowserCuaMcpBrowserMethodSchema = z.enum(
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS,
);
export type NativeBrowserCuaMcpBrowserMethod = z.infer<
  typeof nativeBrowserCuaMcpBrowserMethodSchema
>;

export const nativeBrowserCuaMcpErrorSchema = z.enum([
  "invalid_request",
  "authentication_failed",
  "backend_unavailable",
]);
export type NativeBrowserCuaMcpError = z.infer<typeof nativeBrowserCuaMcpErrorSchema>;

const absolutePathSchema = z.string().trim().min(1).max(4_096);

export const nativeBrowserCuaMcpRequestSchema = z
  .object({
    id: z.string().uuid(),
    token: z.string().min(32).max(256),
    browserId: z.string().trim().min(1).max(256).optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    command: browserCommandSchema.superRefine((command, ctx) => {
      if (!nativeBrowserCuaMcpBrowserMethodSchema.safeParse(command.method).success)
        ctx.addIssue({
          code: "custom",
          path: ["method"],
          message: "Browser command method is not exposed by native Browser/CUA MCP",
        });
    }),
  })
  .strict();
export type NativeBrowserCuaMcpRequest = z.infer<typeof nativeBrowserCuaMcpRequestSchema>;

export const nativeBrowserCuaMcpResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(true),
      result: browserCommandResultSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(false),
      error: nativeBrowserCuaMcpErrorSchema,
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);
export type NativeBrowserCuaMcpResponse = z.infer<typeof nativeBrowserCuaMcpResponseSchema>;

export const nativeBrowserCuaMcpStatusSchema = z
  .object({
    browser: z.boolean(),
    cua: z.boolean(),
    cuaReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type NativeBrowserCuaMcpStatus = z.infer<typeof nativeBrowserCuaMcpStatusSchema>;

export const nativeBrowserCuaMcpDescriptorSchema = z
  .object({
    runtimeInstalled: z.boolean(),
    serviceRunning: z.boolean(),
    executable: absolutePathSchema,
    bridgePath: absolutePathSchema,
    endpoint: absolutePathSchema,
    tokenFile: absolutePathSchema,
    browserAvailable: z.boolean(),
    cuaAvailable: z.boolean(),
    cuaReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type NativeBrowserCuaMcpDescriptor = z.infer<typeof nativeBrowserCuaMcpDescriptorSchema>;

export const nativeBrowserCuaMcpRuntimeMissingDescriptorSchema = z
  .object({
    runtimeInstalled: z.literal(false),
    serviceRunning: z.literal(false),
    executable: z.string().trim().min(1).max(4_096),
    browserAvailable: z.literal(false),
    cuaAvailable: z.literal(false),
    cuaReason: z.string().trim().min(1).max(500),
  })
  .strict();
export type NativeBrowserCuaMcpRuntimeMissingDescriptor = z.infer<
  typeof nativeBrowserCuaMcpRuntimeMissingDescriptorSchema
>;
export const nativeBrowserCuaMcpDescriptorResultSchema = z.union([
  nativeBrowserCuaMcpDescriptorSchema,
  nativeBrowserCuaMcpRuntimeMissingDescriptorSchema,
]);
export type NativeBrowserCuaMcpDescriptorResult = z.infer<
  typeof nativeBrowserCuaMcpDescriptorResultSchema
>;

export function nativeBrowserCuaMcpEndpointPath(input: {
  platform?: NodeJS.Platform | string;
  flavor?: string;
  userDataPath?: string;
  temporaryDirectory?: string;
}): string {
  const flavor = (input.flavor ?? "").replace(/[^a-z0-9-]/giu, "").toLowerCase() || "default";
  if (input.platform === "win32") {
    return `\\\\.\\pipe\\${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}`;
  }
  const root = input.temporaryDirectory ?? input.userDataPath ?? "";
  return `${root.replace(/[\\/]$/u, "")}/${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}.sock`;
}

export function nativeBrowserCuaMcpTokenFilePath(input: {
  flavor?: string;
  userDataPath: string;
}): string {
  const flavor = (input.flavor ?? "").replace(/[^a-z0-9-]/giu, "").toLowerCase() || "default";
  return `${input.userDataPath.replace(/[\\/]$/u, "")}/${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}.token`;
}
