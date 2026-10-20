import { ProxyChannel, type IChannelServer } from "@codez/rpc";
import { UpstreamServiceChannelAliases, type ServiceChannelName } from "@codez/shared";
import type { ServiceDescriptor } from "./descriptors.js";

export interface ServiceExposurePolicy {
  readonly allowedChannels: ReadonlySet<string>;
}

/**
 * ServiceCollection — 服务注册中心
 *
 * 服务端用来注册服务实例，并自动暴露到 ChannelServer。
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** 将所有已注册的服务自动暴露为 channel */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
    exposurePolicy?: ServiceExposurePolicy,
  ): void {
    for (const [channelName, instance] of this._services) {
      if (exposurePolicy && !exposurePolicy.allowedChannels.has(channelName)) continue;
      const exposed = overrides.get(channelName) ?? instance;
      const channel = ProxyChannel.fromService(exposed as Record<string, unknown>);
      server.registerChannel(channelName, channel);
      // Bugfix：上游手机页使用 zcode-*；别名必须复用 scoped override，不能绕过 owner/lease。
      const upstreamAlias = UpstreamServiceChannelAliases[channelName as ServiceChannelName];
      if (upstreamAlias) server.registerChannel(upstreamAlias, channel);
    }
  }
}
