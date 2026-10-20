import { describe, expect, it } from "vitest";
import {
  codezProtocolMethods,
  codezWorkspaceHookTrustGrantParamsSchema,
  codezWorkspaceHookTrustGrantResultSchema,
} from "../src/codez-protocol/index.js";

describe("workspace Hook Trust workspace protocol", () => {
  it("declares an exact workspace/bundle/declaration grant contract", () => {
    expect(codezProtocolMethods.workspaceHookTrustGrant).toBe("workspace/hooks/trustGrant");
    expect(
      codezWorkspaceHookTrustGrantParamsSchema.parse({
        workspace: {
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:host:/repo",
          workspaceKey: "remote:ssh:host:/repo",
        },
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).toEqual(
      expect.objectContaining({
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    );
    expect(
      codezWorkspaceHookTrustGrantResultSchema.parse({
        accepted: false,
        reasonCode: "workspace_hooks_config_unreadable",
      }),
    ).toEqual({ accepted: false, reasonCode: "workspace_hooks_config_unreadable" });
  });

  it("rejects malformed digests and undeclared fields", () => {
    expect(() =>
      codezWorkspaceHookTrustGrantParamsSchema.parse({
        workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
        bundleDigest: "not-a-digest",
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      codezWorkspaceHookTrustGrantResultSchema.parse({ accepted: true, bypassed: true }),
    ).toThrow();
    expect(() =>
      codezWorkspaceHookTrustGrantResultSchema.parse({
        accepted: false,
        reasonCode: "/Users/alice/private/config.json",
      }),
    ).toThrow();
  });
});
