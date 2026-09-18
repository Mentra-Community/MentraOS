import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config";
import { registerResources } from "./resources";
import { registerPrompts } from "./prompts";
import { registerAuthTools } from "./tools/auth";
import { registerReportTools } from "./tools/reports";

export function createMcpServer(config: ConsoleMcpConfig): McpServer {
  const server = new McpServer({
    name: "mentra-console",
    version: "0.2.0",
  });

  registerAuthTools(server, config);

  if (config.capabilities.reports) {
    registerReportTools(server, config);
  }

  registerResources(server, config);
  registerPrompts(server, config);

  return server;
}
