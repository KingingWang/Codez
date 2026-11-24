import {
  createLegacyCredentialCipher,
  type CredentialCipher,
} from "@codez/shared/credential-security";
export type CodezCredentialCipher = CredentialCipher;
export interface CodezCredentialCipherOptions {
  env?: Record<string, string | undefined>;
}
/** 仅兼容旧格式；正式凭据仓库默认使用系统安全存储。 */
export function createCodezCredentialCipher(options: CodezCredentialCipherOptions = {}) {
  return createLegacyCredentialCipher(options.env);
}
export function isEncryptedCodezCredentialValue(value: string): boolean {
  return value.startsWith("enc:");
}
