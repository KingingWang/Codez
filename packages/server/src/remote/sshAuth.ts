import type { ConnectConfig } from "ssh2";
import type { PublicCodezErrorCode } from "@codez/shared";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
  /** 显式关闭隐式 SSH_AUTH_SOCK 回退；auto 模式已完成 agent 端点解析时使用。 */
  disableImplicitAgent?: boolean;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // 密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。
  // 某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽，导致正确密码也无法进入认证。
  // 这里改成“显式传入 agent 才启用”；否则密码模式默认禁用隐式 agent。
  const resolvedAgent =
    input.agent ??
    (hasPassword || input.disableImplicitAgent ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时。
    // 这里显式放宽连接握手超时，既给真实慢连接机会，也让错误归一化能和实际配置保持一致。
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close。
    // 启用 SSH-level keepalive，让 ssh2 在连续无响应后主动触发 error/close，避免 UI 任务长期卡在 loading。
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // 一些 SSH 服务端只开启 keyboard-interactive（challenge-response）而关闭 plain password。
    // 开启 tryKeyboard + 交互回调后，同一份密码可以覆盖这类主机，避免“命令行可登录、应用里认证失败”。
    tryKeyboard: hasPassword,
  };
}

export function createKeyboardInteractiveResponder(password?: string) {
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    finish(prompts.map(() => password));
  };
}

export function normalizeSSHConnectError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    return authenticationError("SSH 认证失败：请检查用户名、密码或私钥配置", error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  if (error instanceof Error) {
    // ssh2 对不同私钥格式（OpenSSH 旧/新格式、PPK）会返回不同文案。
    // 之前仅匹配单一字符串，导致部分“缺少口令/口令错误”场景泄露底层错误文本，用户难以判断应输入哪种凭据。
    // 这里改为模式化归一化，把同类错误稳定映射成产品语义提示，便于用户直接修正输入。
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令", error);
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确", error);
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH 连接失败");
}

function authenticationError(message: string, cause: unknown): Error {
  // 认证发生在懒连接的 probe 内；在仍有 ssh2 结构化原因的边界定码，避免被归成预检失败。
  return Object.assign(new Error(message, { cause }), {
    code: "remote-authentication-failed" satisfies PublicCodezErrorCode,
  });
}

/**
 * SSH 自动认证（authMode: "auto"）的候选解析。
 *
 * 背景：issue #14 —— 本机已配置免密（ssh-agent 或默认密钥）时，连接向导不再强制填写私钥路径。
 * 评估见 docs/issues/remote-connection-ux/07-ssh-agent-default-key-evaluation.md，
 * 实施票见 docs/issues/remote-connection-ux/28-ssh-auto-auth-implementation.md。
 *
 * 支持范围（首期）：普通 RSA/ECDSA/Ed25519 身份；SSH config IdentityFile（由向导写入
 * privateKeyPath）、SSH_AUTH_SOCK agent、Windows 系统 OpenSSH agent 管道、默认私钥白名单。
 * FIDO/security-key、证书、Pageant 不在首期范围。
 */

/**
 * 默认私钥候选白名单与探测顺序（产品契约）。
 * 只探测这三种普通算法文件，不把任意 id_* 通配成可用私钥；*_sk、证书、新算法不支持。
 */
export const SSH_DEFAULT_IDENTITY_FILES = ["id_ed25519", "id_ecdsa", "id_rsa"] as const;

/** Windows 系统 OpenSSH agent 的默认命名管道端点（服务启用时由系统创建）。 */
export const WINDOWS_OPENSSH_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

export interface SSHAutoAuthDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
  readFile: (path: string) => Promise<Buffer>;
  pathExists: (path: string) => Promise<boolean>;
}

const defaultSSHAutoAuthDeps: SSHAutoAuthDeps = {
  env: process.env,
  platform: process.platform,
  homedir,
  readFile: async (path) => await readFile(path),
  pathExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

export interface SSHAutoAuthCandidates {
  /** 可静默使用的私钥内容（未加密，或显式口令由 ssh2 正常解密）。 */
  privateKey?: Buffer;
  /** 私钥来源描述，仅用于诊断日志，不含路径以外的信息。 */
  privateKeySource?: string;
  /** 已确认端点存在的 agent（socket 路径或 Windows 管道）。 */
  agent?: string;
}

/**
 * 判断私钥是否无需口令即可使用。
 * ssh2 对加密私钥在缺少口令时返回 Error（如 "Encrypted private OpenSSH key detected..."），
 * 可用身份返回 ParsedKey；解析失败同样视为不可用，避免把坏文件送进连接流程。
 */
function isKeyUsableWithoutPassphrase(key: Buffer): boolean {
  const parsed = ssh2.utils.parseKey(key);
  return !(parsed instanceof Error);
}

/**
 * 解析 agent 端点。
 * POSIX 下失效/过期的 SSH_AUTH_SOCK 会让 ssh2 的 agent 认证直接报错并消耗认证次数，
 * 因此只有端点真实存在才启用；Windows 无环境变量时探测系统 OpenSSH agent 默认管道。
 */
async function resolveAutoAuthAgentEndpoint(deps: SSHAutoAuthDeps): Promise<string | undefined> {
  const fromEnv = deps.env["SSH_AUTH_SOCK"]?.trim();
  if (fromEnv) {
    if (deps.platform === "win32" || (await deps.pathExists(fromEnv))) {
      return fromEnv;
    }
    return undefined;
  }
  if (deps.platform === "win32" && (await deps.pathExists(WINDOWS_OPENSSH_AGENT_PIPE))) {
    return WINDOWS_OPENSSH_AGENT_PIPE;
  }
  return undefined;
}

/**
 * 解析私钥候选：优先 SSH config IdentityFile（由向导透传的 privateKeyPath），
 * 再按白名单顺序探测默认密钥；加密且没有可用口令的文件跳过，交给 agent 身份。
 */
async function resolveAutoAuthKeyCandidate(
  input: { privateKeyPath?: string; privateKeyPassphrase?: string },
  deps: SSHAutoAuthDeps,
): Promise<{ key: Buffer; source: string } | undefined> {
  const explicitPath = input.privateKeyPath?.trim();
  const candidates: Array<{ path: string; source: string }> = [
    ...(explicitPath
      ? [{ path: explicitPath.replace(/^~/, deps.homedir()), source: "ssh-config-identity" }]
      : []),
    ...SSH_DEFAULT_IDENTITY_FILES.map((name) => ({
      path: join(deps.homedir(), ".ssh", name),
      source: `default:${name}`,
    })),
  ];
  for (const candidate of candidates) {
    let key: Buffer;
    try {
      key = await deps.readFile(candidate.path);
    } catch {
      continue;
    }
    if (input.privateKeyPassphrase) {
      // 显式口令仍交给 ssh2 的正常解密路径，口令错误会走既有「私钥口令错误」归一化。
      return { key, source: candidate.source };
    }
    if (isKeyUsableWithoutPassphrase(key)) {
      return { key, source: candidate.source };
    }
    // 加密私钥且没有口令：auto 模式不在连接前阻断整体流程，跳过文件候选，交给 agent 身份。
  }
  return undefined;
}

/**
 * 汇总 auto 模式的一次性连接候选。
 * 返回 null 表示当前机器没有任何可非交互尝试的身份，调用方应给出明确的补充凭据提示。
 */
export async function resolveSSHAutoAuthCandidates(
  input: { privateKeyPath?: string; privateKeyPassphrase?: string },
  deps: SSHAutoAuthDeps = defaultSSHAutoAuthDeps,
): Promise<SSHAutoAuthCandidates | null> {
  const [agent, key] = await Promise.all([
    resolveAutoAuthAgentEndpoint(deps),
    resolveAutoAuthKeyCandidate(input, deps),
  ]);
  if (!agent && !key) return null;
  return {
    ...(key ? { privateKey: key.key, privateKeySource: key.source } : {}),
    ...(agent ? { agent } : {}),
  };
}
