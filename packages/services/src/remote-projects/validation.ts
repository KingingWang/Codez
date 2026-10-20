import { z } from "zod";
import { REMOTE_ASSET_INSTALL_MODES, SSH_AUTH_MODES } from "@codez/shared";

export const text = z.string().trim().min(1);
export const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: text,
      username: text,
      port: z.number().int().min(1).max(65535).optional(),
      // Bug 修复：issue #14 为 SSH Profile target 新增了显式 authMode，但本机远端项目入口的
      // .strict() targetSchema 漏同步该字段，导致带 authMode 的 SSH 连接在 admitConnection -> saveHost
      // 阶段抛出 Unrecognized key: "authMode" 并在 probe 前直接失败。
      authMode: z.enum(SSH_AUTH_MODES).optional(),
      sshConfigAlias: z.string().optional(),
      privateKeyPath: z.string().optional(),
      passwordCredentialKey: text.optional(),
      privateKeyPassphraseCredentialKey: text.optional(),
      assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
      resourcePackages: z
        .object({ selectedPackageIds: z.array(z.string()).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("wsl"), distro: text.optional(), user: text.optional() }).strict(),
  z.object({ kind: z.literal("docker"), container: text }).strict(),
  z
    .object({
      kind: z.literal("server"),
      url: z.url(),
      name: text.optional(),
      workspacePath: text.optional(),
      serverId: text.optional(),
      tokenCredentialKey: text.optional(),
    })
    .strict(),
]);
export const rootSchema = z
  .object({ rootPath: text, position: z.number().int().nonnegative(), isPrimary: z.boolean() })
  .strict();
export const cacheSchema = z
  .object({ projectId: text, name: text, roots: z.array(rootSchema) })
  .strict()
  .refine(
    ({ roots }) =>
      new Set(roots.map((root) => root.rootPath)).size === roots.length &&
      (roots.length === 0 || roots.filter((root) => root.isPrimary).length === 1),
    "remote-project.invalid-roots",
  );
