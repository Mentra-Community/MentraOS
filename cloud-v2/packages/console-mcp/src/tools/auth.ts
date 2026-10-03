import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config";
import { createAdminReportsClient } from "../http/admin-reports-client";
import { textContent } from "./helpers";

export function registerAuthTools(server: McpServer, config: ConsoleMcpConfig): void {
  server.registerTool(
    "console_auth_status",
    {
      description:
        "Report the configured Cloud V2 core URL and capability groups (no secrets). " +
        "Pass verify: true to also call /api/admin/me and confirm the token is admin-allowlisted.",
      inputSchema: {
        verify: z.boolean().optional().describe("Also verify the token against /api/admin/me"),
      },
    },
    async ({ verify }) => {
      const status: Record<string, unknown> = {
        coreUrl: config.coreUrl,
        capabilities: config.capabilities,
        hints: {
          reports:
            "Set MENTRA_ADMIN_TOKEN: an org API key (msk_...) allowlisted via CLOUD_CORE_ADMIN_EMAILS, " +
            "or a WorkOS access token of an admin user. msk_ keys are env-pinned — match MENTRA_CORE_URL/MENTRA_ENV.",
        },
      };

      if (verify && config.capabilities.reports) {
        try {
          const me = await createAdminReportsClient(config).me();
          status.verified = { admin: me.admin, user: me.user };
        } catch (error) {
          status.verified = { error: error instanceof Error ? error.message : String(error) };
        }
      } else if (verify) {
        status.verified = { error: "MENTRA_ADMIN_TOKEN not set — nothing to verify" };
      }

      return textContent(status);
    },
  );
}
