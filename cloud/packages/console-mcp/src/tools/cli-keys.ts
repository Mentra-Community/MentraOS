import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { createCliClient } from "../http/cli-client.ts";
import { redactSecrets } from "../utils/redact.ts";
import { requireConfirm, textContent, unwrapData } from "./helpers.ts";

export function registerCliKeyTools(server: McpServer, config: ConsoleMcpConfig): void {
  const cli = () => createCliClient(config);

  server.registerTool(
    "cli_key_list",
    { description: "List CLI API keys for the authenticated user.", inputSchema: {} },
    async () => textContent(redactSecrets(unwrapData(await cli().listCliKeys()))),
  );

  server.registerTool(
    "cli_key_create",
    {
      description: "Create a new CLI API key. Token is shown once in the response.",
      inputSchema: {
        name: z.string(),
        expiresInDays: z.number().int().positive().optional(),
      },
    },
    async ({ name, expiresInDays }) => {
      const res = await cli().createCliKey({ name, expiresInDays });
      const data = unwrapData(res);
      return textContent({
        ...redactSecrets(data),
        _warning: "Save the CLI token now — it will not be shown again.",
      });
    },
  );

  server.registerTool(
    "cli_key_get",
    {
      description: "Get CLI key metadata by keyId (not the secret token).",
      inputSchema: { keyId: z.string() },
    },
    async ({ keyId }) => textContent(redactSecrets(unwrapData(await cli().getCliKey(keyId)))),
  );

  server.registerTool(
    "cli_key_update",
    {
      description: "Update CLI key metadata (e.g. name).",
      inputSchema: {
        keyId: z.string(),
        patch: z.record(z.unknown()),
      },
    },
    async ({ keyId, patch }) =>
      textContent(redactSecrets(unwrapData(await cli().updateCliKey(keyId, patch)))),
  );

  server.registerTool(
    "cli_key_revoke",
    {
      description: "Revoke a CLI API key. Requires confirm: true.",
      inputSchema: { keyId: z.string(), confirm: z.boolean() },
    },
    async ({ keyId, confirm }) => {
      requireConfirm(confirm, "cli_key_revoke");
      return textContent(unwrapData(await cli().revokeCliKey(keyId)));
    },
  );
}
