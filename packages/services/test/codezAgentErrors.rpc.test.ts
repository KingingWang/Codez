import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@codez/rpc";
import { describe, expect, it } from "vitest";
import { ICodezAgentService } from "#src/codez-agent/codezAgent.js";
import {
  CODEZ_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  CodezAgentMcpStatusModeUnsupportedError,
} from "#src/codez-agent/codezAgentErrors.js";

describe("Codez Agent RPC errors", () => {
  it("preserves the MCP status-only unsupported code across ChannelClient RPC", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      ICodezAgentService.channelName,
      ProxyChannel.fromService({
        async listMcpServerStatuses() {
          throw new CodezAgentMcpStatusModeUnsupportedError();
        },
      }),
    );
    const service = ProxyChannel.toService<ICodezAgentService>(
      client.getChannel(ICodezAgentService.channelName),
    );

    try {
      await expect(
        service.listMcpServerStatuses({
          mcpServers: [],
          mode: "status",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code: CODEZ_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
        name: "CodezAgentMcpStatusModeUnsupportedError",
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
