import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config.ts";
import { registerResources } from "./resources.ts";
import { registerPrompts } from "./prompts.ts";
import { registerAuthTools } from "./tools/auth.ts";
import { registerAppTools } from "./tools/apps.ts";
import { registerOrgTools } from "./tools/orgs.ts";
import { registerIncidentTools } from "./tools/incidents.ts";
import { registerAdminTools } from "./tools/admin.ts";

export function createMcpServer(config: ConsoleMcpConfig): McpServer {
  const server = new McpServer({
    name: "mentra-console",
    version: "0.1.0",
  });

  registerAuthTools(server, config);

  if (config.capabilities.developer) {
    registerAppTools(server, config);
    registerOrgTools(server, config);
  }

  if (config.capabilities.incidents) {
    registerIncidentTools(server, config);
  }

  if (config.capabilities.admin) {
    registerAdminTools(server, config);
  }

  registerResources(server, config);
  registerPrompts(server, config);

  return server;
}
