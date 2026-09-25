import assert from "node:assert/strict";
import test from "node:test";

import type { IChannel, IChannelClient } from "@codez/rpc";
import { ServiceChannels } from "@codez/shared";

import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

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
