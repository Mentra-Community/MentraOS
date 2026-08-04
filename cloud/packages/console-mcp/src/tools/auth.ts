import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { textContent } from "./helpers.ts";

export function registerAuthTools(server: McpServer, config: ConsoleMcpConfig): void {
  server.registerTool(
    "console_auth_status",
    {
      description:
        "Report Mentra Console MCP host and which capability groups are configured (no secrets).",
      inputSchema: {},
    },
    async () => {
      return textContent({
        host: config.host,
        capabilities: config.capabilities,
        hints: {
          developer:
            "Set MENTRA_CLI_TOKEN (create CLI keys in Developer Console → CLI Keys; not via MCP)",
          incidents: "Set MENTRA_AGENT_API_KEY (internal agent API key)",
          admin:
            "Set MENTRA_ADMIN_JWT or MENTRA_ADMIN_TOKEN (core/session JWT for Mentra admin email; not a CLI key)",
        },
      });
    },
  );
}
