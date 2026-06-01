import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { createAdminClient } from "../http/admin-client.ts";
import { textContent } from "./helpers.ts";

export function registerAdminTools(server: McpServer, config: ConsoleMcpConfig): void {
  const admin = () => createAdminClient(config);

  server.registerTool(
    "admin_check",
    {
      description: "Verify Mentra admin JWT and return admin email.",
      inputSchema: {},
    },
    async () => textContent(await admin().check()),
  );

  server.registerTool(
    "admin_app_stats",
    { description: "Get store submission statistics.", inputSchema: {} },
    async () => textContent(await admin().appStats()),
  );

  server.registerTool(
    "admin_apps_submitted",
    { description: "List apps awaiting store review.", inputSchema: {} },
    async () => textContent(await admin().appsSubmitted()),
  );

  server.registerTool(
    "admin_app_get",
    {
      description: "Get submitted app details for review.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => textContent(await admin().getApp(packageName)),
  );

  server.registerTool(
    "admin_app_approve",
    {
      description: "Approve a submitted app for the store.",
      inputSchema: {
        packageName: z.string(),
        notes: z.string().optional(),
      },
    },
    async ({ packageName, notes }) =>
      textContent(await admin().approveApp(packageName, notes)),
  );

  server.registerTool(
    "admin_app_reject",
    {
      description: "Reject a submitted app. notes is required.",
      inputSchema: {
        packageName: z.string(),
        notes: z.string().min(1, "Rejection notes are required"),
      },
    },
    async ({ packageName, notes }) =>
      textContent(await admin().rejectApp(packageName, notes)),
  );
}
