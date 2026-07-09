import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config";

export function registerPrompts(server: McpServer, _config: ConsoleMcpConfig): void {
  server.registerPrompt(
    "debug-report",
    {
      title: "Debug Report",
      description:
        "Guide for investigating a Cloud V2 bug report: report_get, report_get_logs, then search the repo.",
      argsSchema: {
        reportId: z.string().describe("Full rep_... id or short prefix"),
      },
    },
    async ({ reportId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Investigate MentraOS report ${reportId}:

1. Call report_get with reportId "${reportId}" — note kind, trigger, actual/expected behavior, and the context snapshot (phone/glasses/app state)
2. Call report_get_logs with level "error"; widen with grep or per-source (source "phone", then glasses) as needed
3. Call report_get_artifact for screenshots when the report references UI state
4. Search the codebase for the failing log messages and trigger source
5. Summarize root cause hypothesis and suggested fixes`,
          },
        },
      ],
    }),
  );
}
