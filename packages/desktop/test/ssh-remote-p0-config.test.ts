import { afterEach, describe, expect, it } from "vitest";
import { readSingleSSHWorkspaceRuntimeConfig } from "./e2e/helpers/ssh-remote-p0.js";

const ENV_KEYS = [
  "CODEZ_E2E_SSH_HOST",
  "CODEZ_E2E_SSH_PORT",
  "CODEZ_E2E_SSH_USERNAME",
  "CODEZ_E2E_SSH_PASSWORD",
  "CODEZ_E2E_SSH_WORKSPACE_PATH",
  "CODEZ_E2E_SSH_SHARED_WORKSPACE_PATH",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("SSH remote E2E config helpers", () => {
  it("reads a single target without requiring a second SSH identity", () => {
    process.env.CODEZ_E2E_SSH_HOST = "e2e.example.test";
    process.env.CODEZ_E2E_SSH_USERNAME = "e2e-user";
    process.env.CODEZ_E2E_SSH_PASSWORD = "e2e-password";
    process.env.CODEZ_E2E_SSH_PORT = "2222";
    process.env.CODEZ_E2E_SSH_WORKSPACE_PATH = "/root/workspace";

    expect(readSingleSSHWorkspaceRuntimeConfig("E2E_SSH_SINGLE")).toEqual({
      host: "e2e.example.test",
      password: "e2e-password",
      port: 2222,
      username: "e2e-user",
      workspacePath: "/root/workspace",
    });
  });
});
