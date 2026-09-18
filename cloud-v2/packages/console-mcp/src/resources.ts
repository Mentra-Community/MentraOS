import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config";
import { createAdminReportsClient } from "./http/admin-reports-client";
import { resolveReport } from "./utils/id-resolution";
import { compactReportRow } from "./tools/reports";

export function registerResources(server: McpServer, config: ConsoleMcpConfig): void {
  if (!config.capabilities.reports) {
    return;
  }

  server.registerResource(
    "reports-recent",
    "mentra://reports/recent",
    {
      title: "Recent Reports",
      description: "Compact rows for the 25 most recent Cloud V2 reports",
      mimeType: "application/json",
    },
    async () => {
      const { reports } = await createAdminReportsClient(config).listReports({ limit: 25 });
      return {
        contents: [
          {
            uri: "mentra://reports/recent",
            mimeType: "application/json",
            text: JSON.stringify(reports.map(compactReportRow), null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "report-summary",
    new ResourceTemplate("mentra://reports/{reportId}/summary", { list: undefined }),
    {
      title: "Report Summary",
      description: "Report document and artifact metadata without the context snapshot",
      mimeType: "application/json",
    },
    async (uri, { reportId }) => {
      const { report } = await resolveReport(
        createAdminReportsClient(config),
        String(reportId),
      );
      const { context: _context, ...summary } = report;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
