import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "./config.ts";

export function registerPrompts(server: McpServer, _config: ConsoleMcpConfig): void {
  server.registerPrompt(
    "debug-incident",
    {
      title: "Debug Incident",
      description:
        "Guide for investigating a bug report: use incident_get and incident_get_logs, then search the repo.",
      argsSchema: {
        incidentId: z.string().describe("Full UUID or 8-char prefix"),
      },
    },
    async ({ incidentId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Investigate MentraOS incident ${incidentId}:

1. Call incident_get with incidentId "${incidentId}"
2. Call incident_get_logs with logType "phone" and grep for errors; repeat for "cloud" if needed
3. Note sourceAppletPackageName and user feedback from metadata
4. Search the codebase for relevant failure patterns
5. Summarize root cause hypothesis and suggested fixes`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "create-miniapp-checklist",
    {
      title: "Create MiniApp Checklist",
      description: "Steps to register and configure a new MentraOS MiniApp via console MCP tools.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Create a new MentraOS MiniApp using console MCP tools:

1. org_list — confirm target organization (or org_create)
2. app_create — packageName, name, publicUrl, appType, permissions as needed
3. Save the returned apiKey immediately
4. app_update — add tools, settings, hardwareRequirements if needed
5. app_publish when ready for store review
6. Document server URL and packageName in the app codebase`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review-submission",
    {
      title: "Review Store Submission",
      description: "Internal admin checklist for reviewing a submitted app.",
      argsSchema: {
        packageName: z.string(),
      },
    },
    async ({ packageName }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review store submission for ${packageName}:

1. admin_app_get for package ${packageName}
2. Verify permissions, publicUrl, and store guidelines compliance
3. admin_app_approve with notes OR admin_app_reject with required rejection notes`,
          },
        },
      ],
    }),
  );
}
