import type { ICodexNativeProviderKeyService } from "@codez/services";
import {
  codexProviderCreateEdits,
  codexProviderDeleteEdits,
  codexProviderUpdateEdits,
  isCodexManagedEnvKey,
  type CodexConfigEdit,
  type CodexProviderForm,
  type CodexProviderView,
} from "./codexProviderSettings.js";

/**
 * Codex 供应商 Key 保存事务的 UI 侧编排（spec: codex-provider-runtime-env-key）：
 * prepare（远程屏障 + 本机凭据）→ config/batchWrite（只写引用）→ finish（逐连接安装）。
 * 任何一步失败都经 finish(commit=false) 恢复旧凭据；恢复失败时聚合两个错误抛出。
 */
export interface CodexProviderKeyFlowDeps {
  keyService?: ICodexNativeProviderKeyService;
  keySourceSupported: boolean;
  unsupportedMessage: string;
  writeEdits: (edits: CodexConfigEdit[]) => Promise<void>;
}

async function rollbackKeySource(
  keyService: ICodexNativeProviderKeyService,
  providerId: string,
  cause: unknown,
): Promise<never> {
  await keyService
    .finishKeySource({ providerId, commit: false })
    .catch((rollbackError: unknown) => {
      throw new AggregateError(
        [cause, rollbackError],
        "配置写入与凭据恢复均失败",
      );
    });
  throw cause;
}

export async function saveCodexProviderWithKeySource(
  deps: CodexProviderKeyFlowDeps,
  input: { form: CodexProviderForm; creating: boolean },
): Promise<void> {
  const { form, creating } = input;
  const providerId = form.id.trim();
  const wantsManaged = form.keySource === "runtime-env";
  const wasManaged = isCodexManagedEnvKey(form.initialEnvKey);
  let envName: string | undefined;
  let prepared = false;
  if (wantsManaged || wasManaged) {
    if (!deps.keyService || !deps.keySourceSupported) {
      throw new Error(deps.unsupportedMessage);
    }
    const preparedResult = await deps.keyService.prepareKeySource({
      providerId,
      mode: wantsManaged ? "runtime-env" : "config-file",
      ...(form.bearerToken.trim() ? { apiKey: form.bearerToken.trim() } : {}),
    });
    prepared = true;
    envName = preparedResult.envName;
  }
  const edits = creating
    ? codexProviderCreateEdits(form, { envName })
    : codexProviderUpdateEdits(form, { envName });
  try {
    await deps.writeEdits(edits);
  } catch (error) {
    if (prepared) await rollbackKeySource(deps.keyService!, providerId, error);
    throw error;
  }
  if (prepared)
    await deps.keyService!.finishKeySource({ providerId, commit: true });
}

/** 删除供应商：托管引用存在时同步清理本机凭据与注册表，失败则整事务回滚。 */
export async function deleteCodexProviderWithKeyCleanup(
  deps: CodexProviderKeyFlowDeps,
  view: CodexProviderView,
): Promise<void> {
  const managed = isCodexManagedEnvKey(view.envKey);
  if (managed && (!deps.keyService || !deps.keySourceSupported)) {
    // 旧 Host 无法清理本机凭据/注册表；宁可拒绝删除也不留孤儿引用。
    throw new Error(deps.unsupportedMessage);
  }
  let prepared = false;
  if (managed) {
    await deps.keyService!.prepareKeySource({
      providerId: view.id,
      mode: "delete",
    });
    prepared = true;
  }
  try {
    await deps.writeEdits(codexProviderDeleteEdits(view.id));
  } catch (error) {
    if (prepared) await rollbackKeySource(deps.keyService!, view.id, error);
    throw error;
  }
  if (prepared)
    await deps.keyService!.finishKeySource({
      providerId: view.id,
      commit: true,
    });
}
