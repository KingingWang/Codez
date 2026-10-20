import assert from "node:assert/strict";
import { describe, expect, it as test, vi } from "vitest";

import type { IChannel, IChannelClient } from "@codez/rpc";
import { ISourceServerManagementService } from "@codez/services";
import { ServiceChannels } from "@codez/shared";
import { IMediaPreviewService, IClientConfigService } from "@codez/services";

import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

describe("RemoteServiceAccess", () => {
  test("公开配置经独立频道 RPC 读取", async () => {
    const call = vi.fn(async () => ({ pluginStoreOrder: null }));
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.clientConfigService.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
    });
    expect(requested).toContain("client-config");
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getSnapshot", [{ forceRefresh: true }]]);
  });
});

describe("RemoteServiceAccess optional channels", () => {
  test("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });
});

test("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});

describe("RemoteServiceAccess media and codex proxies", () => {
  test("creates the media preview proxy for every remote service connection", () => {
    const channelNames: string[] = [];
    const channel: IChannel = { call: vi.fn(), listen: vi.fn() };
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        channelNames.push(name);
        return channel;
      },
    });
    expect(channelNames).toContain(IMediaPreviewService.channelName);
    expect(services.mediaPreviewService).toBeDefined();
    expect(channelNames).toContain(IClientConfigService.channelName);
    expect(services.clientConfigService).toBeDefined();
  });
});

interface RecordedCall {
  channel: string;
  command: string;
  arg: unknown;
}

function createRecordingClient() {
  const requestedChannels: string[] = [];
  const calls: RecordedCall[] = [];
  const client: IChannelClient = {
    getChannel(channelName: string) {
      requestedChannels.push(channelName);
      return {
        call: (command: string, arg?: unknown) => {
          calls.push({ channel: channelName, command, arg });
          return Promise.resolve(null);
        },
        listen: () => () => ({ dispose() {} }),
      } as unknown as IChannel;
    },
  };
  return { client, requestedChannels, calls };
}

// 回归：renderer accessor 曾缺少 codexDesktopFileRewindService 代理，导致
// Boolean(services.codexDesktopFileRewindService) 恒为 false，Desktop 撤销按钮永远禁用。
test("RemoteServiceAccess 暴露 codexDesktopFileRewindService 代理", async () => {
  const { client, requestedChannels, calls } = createRecordingClient();
  const services = new RemoteServiceAccess(client);

  assert.ok(
    services.codexDesktopFileRewindService,
    "renderer accessor 必须暴露 codexDesktopFileRewindService 代理",
  );
  assert.ok(requestedChannels.includes(ServiceChannels.CodexDesktopFileRewind));

  const params = {
    workspacePath: "/tmp/workspace",
    sessionId: "session-1",
    target: { rowId: 7, entityId: "entity-1" },
    baseRevision: 3,
    baseLogEpoch: "epoch-1",
    confirmationId: "confirm-1",
  };
  await services.codexDesktopFileRewindService.apply(params);
  await services.codexDesktopFileRewindService.preview({
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    target: params.target,
    baseRevision: params.baseRevision,
    baseLogEpoch: params.baseLogEpoch,
  });

  assert.deepEqual(calls, [
    {
      channel: ServiceChannels.CodexDesktopFileRewind,
      command: "apply",
      arg: [params],
    },
    {
      channel: ServiceChannels.CodexDesktopFileRewind,
      command: "preview",
      arg: [
        {
          workspacePath: params.workspacePath,
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
      ],
    },
  ]);
});
