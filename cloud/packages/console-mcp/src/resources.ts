import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config.ts";
import { createAgentClient } from "./http/agent-client.ts";
import { createCliClient } from "./http/cli-client.ts";
import { redactSecrets } from "./utils/redact.ts";
import { unwrapData } from "./tools/helpers.ts";

export function registerResources(server: McpServer, config: ConsoleMcpConfig): void {
  if (config.capabilities.developer) {
    server.registerResource(
      "apps-list",
      "mentra://apps",
      {
        title: "Developer Apps",
        description: "List of MiniApps for the authenticated developer",
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri: "mentra://apps",
            mimeType: "application/json",
            text: JSON.stringify(
              redactSecrets(unwrapData(await createCliClient(config).listApps())),
              null,
              2,
            ),
          },
        ],
      }),
    );

    server.registerResource(
      "app-config",
      new ResourceTemplate("mentra://apps/{packageName}", { list: undefined }),
      {
        title: "App Config",
        description: "MiniApp configuration by package name",
        mimeType: "application/json",
      },
      async (uri, { packageName }) => {
        const res = await createCliClient(config).getApp(String(packageName));
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(redactSecrets(unwrapData(res)), null, 2),
            },
          ],
        };
      },
    );
  }

  if (config.capabilities.incidents) {
    server.registerResource(
      "incidents-recent",
      "mentra://incidents/recent",
      {
        title: "Recent Incidents",
        description: "Recent bug report incident summaries",
        mimeType: "application/json",
      },
      async () => {
        const res = await createAgentClient(config).listIncidents(25, 0);
        return {
          contents: [
            {
              uri: "mentra://incidents/recent",
              mimeType: "application/json",
              text: JSON.stringify(res.data, null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      "incident-summary",
      new ResourceTemplate("mentra://incidents/{incidentId}/summary", {
        list: undefined,
      }),
      {
        title: "Incident Summary",
        description: "Compact incident metadata (no full logs)",
        mimeType: "application/json",
      },
      async (uri, { incidentId }) => {
        const agent = createAgentClient(config);
        const res = await agent.getIncident(String(incidentId));
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(unwrapData(res), null, 2),
            },
          ],
        };
      },
    );
  }
}
