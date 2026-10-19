import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemoteConnectionError, publicCodezErrorCodeSchema } from "@codez/shared";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
  resolveSSHAutoAuthCandidates,
  SSH_DEFAULT_IDENTITY_FILES,
  WINDOWS_OPENSSH_AGENT_PIPE,
  type SSHAutoAuthDeps,
} from "../src/remote/sshAuth.js";

const originalAuthSock = process.env["SSH_AUTH_SOCK"];

afterEach(() => {
  if (originalAuthSock == null) {
    delete process.env["SSH_AUTH_SOCK"];
    return;
  }
  process.env["SSH_AUTH_SOCK"] = originalAuthSock;
});

describe("sshAuth", () => {
  it("密码登录时默认禁用隐式 agent，并启用 keyboard-interactive", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    expect(config.agent).toBeUndefined();
    expect(config.tryKeyboard).toBe(true);
    expect(config.password).toBe("secret");
  });

  it("无密码时保留隐式 agent", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
  });

  it("auto 模式显式关闭隐式 agent 回退，避免死 socket 消耗认证次数", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      disableImplicitAgent: true,
    });

    expect(config.agent).toBeUndefined();
  });

  it("显式传入 agent 时应覆盖默认策略", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
      agent: "/tmp/custom.sock",
    });

    expect(config.agent).toBe("/tmp/custom.sock");
  });

  it("连接配置应显式设置 readyTimeout 和 keepalive，避免静默断连长期悬挂", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.readyTimeout).toBe(60_000);
    expect(config.keepaliveInterval).toBe(15_000);
    expect(config.keepaliveCountMax).toBe(3);
  });

  it("私钥口令只用于解密私钥，不应改变密码登录分支判断", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      privateKey: "test-private-key",
      passphrase: "key-secret",
    });

    expect(config.passphrase).toBe("key-secret");
    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
    expect(config.password).toBeUndefined();
  });

  it("keyboard-interactive 回调应使用同一密码响应全部 prompt", () => {
    const responder = createKeyboardInteractiveResponder("secret");
    let responses: string[] = [];
    responder(
      "",
      "",
      "",
      [
        { prompt: "Password:", echo: false },
        { prompt: "OTP:", echo: false },
      ],
      (nextResponses) => {
        responses = nextResponses;
      },
    );

    expect(responses).toEqual(["secret", "secret"]);
  });

  it("client-authentication 错误应转换为可读信息", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    expect(error.message).toContain("SSH 认证失败");
  });

  it.each([
    Object.assign(new Error("authentication wording may change"), {
      level: "client-authentication",
    }),
    Object.assign(new Error("Permission denied"), { level: "client-authentication" }),
    new Error("OpenSSH key integrity check failed -- bad passphrase?"),
    new Error("Encrypted private OpenSSH key detected, but no passphrase given"),
  ])("认证错误经过预检仍保留公开认证码及原始 cause", (cause) => {
    const error = normalizeSSHConnectError(cause);
    expect(error.cause).toBe(cause);
    const failure = normalizeRemoteConnectionError(error, "preflight");
    expect(failure.code).toBe("remote-authentication-failed");
    expect(publicCodezErrorCodeSchema.parse(failure.code)).toBe(failure.code);
  });

  it("文件权限错误不被认证分类吞掉", () => {
    const error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    expect(normalizeRemoteConnectionError(normalizeSSHConnectError(error), "preflight").code).toBe(
      "remote-permission-denied",
    );
  });

  it("client-timeout 错误应说明是 SSH 连接握手超时", () => {
    const error = normalizeSSHConnectError({ level: "client-timeout" });
    expect(error.message).toBe(
      "SSH 连接握手超时：未能在 60 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异",
    );
  });

  it("私钥缺少口令的错误文案变体应统一转换为可读提示", () => {
    const expectedMessage = "SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令";
    const cases = [
      "Encrypted private OpenSSH key detected, but no passphrase given",
      "Encrypted OpenSSH private key detected, but no passphrase given",
      "Encrypted PPK private key detected, but no passphrase given",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });

  it("私钥口令错误应转换为可读提示", () => {
    const expectedMessage = "SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确";
    const cases = [
      "OpenSSH key integrity check failed -- bad passphrase?",
      "PPK private key integrity check failed -- bad passphrase?",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });
});
const UNENCRYPTED_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAxDkW9Buuk2LsFvOnfTZgpu9kEqxsL3CVkWzuciFZCOgAAAJg9kg6hPZIO
oQAAAAtzc2gtZWQyNTUxOQAAACAxDkW9Buuk2LsFvOnfTZgpu9kEqxsL3CVkWzuciFZCOg
AAAEAfslSLgHewXSddBVexerWTnFSau66lautAbSZblkEtKDEORb0G66TYuwW86d9NmCm7
2QSrGwvcJWRbO5yIVkI6AAAAD2NvZGV6LXRlc3Qtb25seQECAwQFBg==
-----END OPENSSH PRIVATE KEY-----
`;

const ENCRYPTED_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABA1mq6Xhf
aAvjzjBzC4rvA5AAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIPWLR6xh0zY4W0Jz
vh1rdDm09uxf4NgFBKxHfx9MSujoAAAAoCx4UuUb9wEo4GZ2y4703fY/zqaKA4fkr+uOyN
LMVDjhU5574uNsXUTiA6q3cB2RHlKeUEU6x9D9nRNbU9Yd8tS7fqmusHS+nSLstFc56iPF
mdmaE8tPT/1ElMCNzZ/8RCMViAyyvJQr/QgYRgoPmkVgaNg6+c5R08/TBe0VqUwCpuZ3Cj
NVG8ykJG48jIM9tqGW4jQLoA8orCjRZAfhCrw=
-----END OPENSSH PRIVATE KEY-----
`;

interface FakeFs {
  files: Record<string, Buffer>;
  existingPaths: Set<string>;
}

function createDeps(overrides: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: FakeFs;
}): SSHAutoAuthDeps {
  const fs = overrides.fs ?? { files: {}, existingPaths: new Set<string>() };
  return {
    env: overrides.env ?? {},
    platform: overrides.platform ?? "linux",
    homedir: () => overrides.home ?? "/home/tester",
    readFile: async (path) => {
      const content = fs.files[path];
      if (!content) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    pathExists: async (path) => fs.existingPaths.has(path),
  };
}

describe("resolveSSHAutoAuthCandidates", () => {
  it("SSH config IdentityFile 未加密且无口令时直接使用", async () => {
    const deps = createDeps({
      fs: {
        files: { "/home/tester/.ssh/config_key": Buffer.from(UNENCRYPTED_KEY) },
        existingPaths: new Set(),
      },
    });
    const candidates = await resolveSSHAutoAuthCandidates(
      { privateKeyPath: "~/.ssh/config_key" },
      deps,
    );
    expect(candidates?.privateKey?.toString()).toBe(UNENCRYPTED_KEY);
    expect(candidates?.privateKeySource).toBe("ssh-config-identity");
    expect(candidates?.agent).toBeUndefined();
  });

  it("config 私钥加密且没有口令时跳过文件候选，回退到可用 agent", async () => {
    const deps = createDeps({
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock" },
      fs: {
        files: { "/home/tester/.ssh/config_key": Buffer.from(ENCRYPTED_KEY) },
        existingPaths: new Set(["/run/user/1000/ssh-agent.sock"]),
      },
    });
    const candidates = await resolveSSHAutoAuthCandidates(
      { privateKeyPath: "~/.ssh/config_key" },
      deps,
    );
    expect(candidates?.privateKey).toBeUndefined();
    expect(candidates?.agent).toBe("/run/user/1000/ssh-agent.sock");
  });

  it("config 私钥加密但提供了口令时仍使用文件候选", async () => {
    const deps = createDeps({
      fs: {
        files: { "/home/tester/.ssh/config_key": Buffer.from(ENCRYPTED_KEY) },
        existingPaths: new Set(),
      },
    });
    const candidates = await resolveSSHAutoAuthCandidates(
      { privateKeyPath: "~/.ssh/config_key", privateKeyPassphrase: "test-pass" },
      deps,
    );
    expect(candidates?.privateKey?.toString()).toBe(ENCRYPTED_KEY);
  });

  it("按白名单顺序探测默认密钥，跳过加密文件选择第一个可静默使用的", async () => {
    const home = "/home/tester";
    const deps = createDeps({
      home,
      fs: {
        files: {
          [`${home}/.ssh/id_ed25519`]: Buffer.from(ENCRYPTED_KEY),
          [`${home}/.ssh/id_ecdsa`]: Buffer.from(UNENCRYPTED_KEY),
        },
        existingPaths: new Set(),
      },
    });
    const candidates = await resolveSSHAutoAuthCandidates({}, deps);
    expect(candidates?.privateKeySource).toBe("default:id_ecdsa");
  });

  it("损坏的私钥文件不会被当作候选", async () => {
    const deps = createDeps({
      fs: {
        files: { "/home/tester/.ssh/id_ed25519": Buffer.from("not a key") },
        existingPaths: new Set(),
      },
    });
    await expect(resolveSSHAutoAuthCandidates({}, deps)).resolves.toBeNull();
  });

  it("失效的 SSH_AUTH_SOCK 不进入候选", async () => {
    const deps = createDeps({
      env: { SSH_AUTH_SOCK: "/tmp/dead.sock" },
      fs: { files: {}, existingPaths: new Set() },
    });
    await expect(resolveSSHAutoAuthCandidates({}, deps)).resolves.toBeNull();
  });

  it("Windows 无 SSH_AUTH_SOCK 时探测系统 OpenSSH agent 管道", async () => {
    const deps = createDeps({
      platform: "win32",
      fs: { files: {}, existingPaths: new Set([WINDOWS_OPENSSH_AGENT_PIPE]) },
    });
    const candidates = await resolveSSHAutoAuthCandidates({}, deps);
    expect(candidates?.agent).toBe(WINDOWS_OPENSSH_AGENT_PIPE);
  });

  it("Windows 上管道不存在且无其他候选时返回 null", async () => {
    const deps = createDeps({ platform: "win32" });
    await expect(resolveSSHAutoAuthCandidates({}, deps)).resolves.toBeNull();
  });

  it("默认密钥白名单只包含三种普通算法文件", () => {
    expect(SSH_DEFAULT_IDENTITY_FILES).toEqual(["id_ed25519", "id_ecdsa", "id_rsa"]);
  });
});
