import { Emitter } from "@codez/rpc";
import type { IModelSelectionService, ModelSelectionView } from "@codez/services";
import { describe, expect, it, vi } from "vitest";
import { scopeModelSelectionServiceForAttachment } from "../src/host/modelSelectionAttachmentScope.js";

describe("mobile model selection attachment scope", () => {
  const target = { workspacePath: "/workspace", workspaceIdentity: "identity-a" };
  function fixture() {
    const changes = new Emitter<ModelSelectionView>();
    const service: IModelSelectionService = {
      onDidChange: changes.event,
      getView: vi.fn(async () => ({ revision: 1, providers: [] })),
    };
    return { service, changes };
  }

  it("上游省略 workspace 时绑定已有 attachment 的身份，并保留 selection", async () => {
    const { service } = fixture();
    const scoped = scopeModelSelectionServiceForAttachment(service, "web-remote-replayable", {
      kind: "local",
      ...target,
    });
    await scoped.getView();
    const selection = { providerId: "provider", modelId: "model" };
    await scoped.getView({ selection });
    expect(service.getView).toHaveBeenNthCalledWith(1, { selection: null, workspace: target });
    expect(service.getView).toHaveBeenNthCalledWith(2, { selection, workspace: target });
  });

  it("拒绝同路径不同 identity 的请求，不访问其他 workspace", async () => {
    const { service } = fixture();
    const scoped = scopeModelSelectionServiceForAttachment(service, "web-remote-replayable", {
      kind: "remote",
      remoteSessionId: "remote-1",
      ...target,
    });
    await expect(
      scoped.getView({ workspace: { ...target, workspaceIdentity: "identity-b" } }),
    ).rejects.toThrow("workspace");
    expect(service.getView).not.toHaveBeenCalled();
  });

  it("仅转发当前 workspace 和 legacy 全局事件，不新增订阅所有者", () => {
    const { service, changes } = fixture();
    const scoped = scopeModelSelectionServiceForAttachment(service, "web-remote-replayable", {
      kind: "local",
      ...target,
    });
    const listener = vi.fn();
    const subscription = scoped.onDidChange(listener);
    changes.fire({
      revision: 10,
      providers: [],
      workspace: { ...target, workspaceIdentity: "identity-b" },
    });
    const own = { revision: 1, providers: [], workspace: target };
    changes.fire(own);
    changes.fire({ revision: 2, providers: [] });
    expect(listener.mock.calls).toEqual([[own], [{ revision: 2, providers: [] }]]);
    subscription.dispose();
    changes.fire(own);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("本地路径 fallback 可用；continuous 和未绑定 workspace 的连接保持原服务", async () => {
    const { service } = fixture();
    const local = scopeModelSelectionServiceForAttachment(service, "web-remote-replayable", {
      kind: "local",
      workspacePath: "/local",
    });
    await local.getView();
    expect(service.getView).toHaveBeenCalledWith({
      selection: null,
      workspace: { workspacePath: "/local" },
    });
    expect(
      scopeModelSelectionServiceForAttachment(service, "desktop-continuous", {
        kind: "local",
        ...target,
      }),
    ).toBe(service);
    expect(
      scopeModelSelectionServiceForAttachment(service, "web-remote-replayable", { kind: "local" }),
    ).toBe(service);
  });
});
