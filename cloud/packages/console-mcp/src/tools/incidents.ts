import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { createAgentClient } from "../http/agent-client.ts";
import { resolveIncidentId } from "../utils/id-resolution.ts";
import {
  collectLogEntries,
  filterLogEntries,
  formatLogLines,
  type LogType,
} from "../utils/incident-filter.ts";
import { textContent, unwrapData } from "./helpers.ts";

export function registerIncidentTools(server: McpServer, config: ConsoleMcpConfig): void {
  const agent = () => createAgentClient(config);

  server.registerTool(
    "incident_list",
    {
      description: "List recent bug-report incidents (agent API).",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        userId: z.string().optional().describe("Client-side filter after fetch"),
      },
    },
    async ({ limit = 100, offset = 0, userId }) => {
      const res = await agent().listIncidents(limit, offset);
      let data = res.data;
      if (userId) {
        data = data.filter((i) => i.userId.includes(userId));
      }
      return textContent({ ...res, data });
    },
  );

  server.registerTool(
    "incident_get",
    {
      description: "Get incident metadata by full UUID or 8-char prefix.",
      inputSchema: { incidentId: z.string() },
    },
    async ({ incidentId }) => {
      const client = agent();
      const fullId = await resolveIncidentId(client, incidentId);
      const res = await client.getIncident(fullId);
      return textContent(unwrapData(res));
    },
  );

  server.registerTool(
    "incident_get_logs",
    {
      description:
        "Fetch incident logs with filtering. Defaults to max 200 lines. logType: phone|cloud|glasses|firmware|apps|all.",
      inputSchema: {
        incidentId: z.string(),
        logType: z
          .enum(["phone", "cloud", "glasses", "firmware", "apps", "all"])
          .optional(),
        appPackage: z.string().optional(),
        level: z.enum(["error", "warn", "info", "debug"]).optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        json: z.boolean().optional(),
      },
    },
    async ({ incidentId, logType, appPackage, level, grep, limit, json }) => {
      const client = agent();
      const fullId = await resolveIncidentId(client, incidentId);
      const res = await client.getIncidentLogs(fullId);
      const data = unwrapData(res);
      const collected = collectLogEntries(data, (logType as LogType) || "all", appPackage);
      const { entries, truncated } = filterLogEntries(collected, {
        logType: logType as LogType,
        level,
        grep,
        limit: limit ?? 200,
      });

      if (json) {
        return textContent({ entries, truncated, incidentId: fullId });
      }

      if (entries.length === 0) {
        return textContent("No log entries found matching filters.");
      }

      let text = formatLogLines(entries);
      if (truncated) {
        text += `\n\n... truncated at ${limit ?? 200} entries. Increase limit to show more.`;
      }
      return textContent(text);
    },
  );
}
