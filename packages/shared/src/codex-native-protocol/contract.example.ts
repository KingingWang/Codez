import { codexRequestSchema, resolveCodexTitleModel } from "./contract.js";

export const nativeSettingsRequestExample = codexRequestSchema.parse({
  method: "model/list",
});

export const workspaceTitlePreferenceExample = resolveCodexTitleModel(
  {},
  "/example/workspace",
  "example-workspace-identity",
);
