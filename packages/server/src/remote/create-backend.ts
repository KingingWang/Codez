import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@codez/shared";
import type { IRemoteBackend } from "./backend.js";

export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      const { SSHBackend } = await import("./ssh-backend.js");
      let privateKey: string | Buffer | undefined;
      let agent: string | undefined;
      // 自动认证（issue #14）：不再强制私钥路径；候选为 config IdentityFile、ssh-agent
      // 与默认私钥白名单，全部不可用时给出明确的补充凭据提示而不是含糊的认证失败。
      let disableImplicitAgent = false;
      if (target.authMode === "auto") {
        // 与 ssh-backend 一样保持动态导入，避免 server 入口在无 SSH 场景也加载 ssh2。
        const { resolveSSHAutoAuthCandidates } = await import("./sshAuth.js");
        const candidates = await resolveSSHAutoAuthCandidates({
          privateKeyPath: target.privateKeyPath,
          privateKeyPassphrase: target.privateKeyPassphrase,
        });
        if (!candidates) {
          throw new Error(
            "SSH 自动认证不可用：未检测到可用的 ssh-agent，也没有可直接使用的私钥（SSH 配置 IdentityFile 或 ~/.ssh/id_ed25519、id_ecdsa、id_rsa）。请改用密码认证，或手动指定私钥。",
          );
        }
        privateKey = candidates.privateKey;
        agent = candidates.agent;
        // auto 已完成 agent 端点解析（含存在性预检），禁止 buildSSHConnectConfig
        // 再回退到未验证的 SSH_AUTH_SOCK，避免死 socket 在密钥失败时消耗认证次数。
        disableImplicitAgent = true;
      } else if (target.privateKeyPath) {
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }

      return new SSHBackend({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKeyPath: target.privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
        agent,
        disableImplicitAgent,
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
    case "server":
      throw new Error(
        "server remote target connects to an existing server and has no deploy backend",
      );
  }
}
