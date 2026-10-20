import type { IServerChannel } from "@codez/rpc";
import { ServiceChannels } from "@codez/shared";
import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "../src/collection.js";
import { createServiceDescriptor } from "../src/descriptors.js";

describe("ServiceCollection connection override", () => {
  it.each([
    [ServiceChannels.CodezTask, "zcode-task"],
    [ServiceChannels.CodezAgent, "zcode-agent"],
    [ServiceChannels.CodezSession, "zcode-session"],
  ])("上游 %s 别名复用同一 connection override 和命令路径", async (name, alias) => {
    const descriptor = createServiceDescriptor<{ write(input: string): string }>(name);
    const base = { write: vi.fn(() => "base") };
    const scoped = { write: vi.fn((input: string) => `mobile:${input}`) };
    const collection = new ServiceCollection().register(descriptor, base);
    const channels = new Map<string, IServerChannel<unknown>>();
    const server = {
      registerChannel: (channelName: string, channel: IServerChannel<unknown>) =>
        channels.set(channelName, channel),
    };
    collection.exposeOnChannelServer(server as never, new Map([[name, scoped]]));
    expect(channels.has(alias)).toBe(true);
    expect(channels.get(alias)).toBe(channels.get(name));
    expect(await channels.get(alias)?.call({}, "write", ["upstream"])).toBe("mobile:upstream");
    expect(await channels.get(name)?.call({}, "write", ["fork"])).toBe("mobile:fork");
    expect(scoped.write.mock.calls).toEqual([["upstream"], ["fork"]]);
    expect(base.write).not.toHaveBeenCalled();
    expect(collection.get(descriptor)).toBe(base);
  });

  it("单个 ChannelServer 可覆盖 service，不修改共享 collection", async () => {
    const descriptor = createServiceDescriptor<{ read(): string }>("scoped-test");
    const collection = new ServiceCollection().register(descriptor, {
      read: () => "base",
    });
    const channels = new Map<string, IServerChannel<unknown>>();
    const server = {
      registerChannel: vi.fn((name: string, channel: IServerChannel<unknown>) => {
        channels.set(name, channel);
      }),
    };

    collection.exposeOnChannelServer(
      server as never,
      new Map([[descriptor.channelName, { read: () => "connection-a" }]]),
    );
    expect(await channels.get(descriptor.channelName)?.call({}, "read", [])).toBe("connection-a");
    expect(collection.get(descriptor).read()).toBe("base");
  });
});
