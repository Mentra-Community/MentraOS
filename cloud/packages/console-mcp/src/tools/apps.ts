import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { createCliClient } from "../http/cli-client.ts";
import { redactSecrets } from "../utils/redact.ts";
import {
  APP_CREATE_FIELDS,
  requireConfirm,
  textContent,
  unwrapData,
} from "./helpers.ts";

const appCreateSchema = z.object({
  packageName: z.string().describe("Reverse-domain package name, e.g. com.example.myapp"),
  name: z.string(),
  publicUrl: z.string().url(),
  appType: z.enum(["background", "standard"]).optional(),
  description: z.string().optional(),
  orgId: z.string().optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  permissions: z.array(z.record(z.unknown())).optional(),
  settings: z.array(z.record(z.unknown())).optional(),
  hardwareRequirements: z.record(z.unknown()).optional(),
  onboardingInstructions: z.string().optional(),
});

const appUpdateSchema = z.object({
  packageName: z.string(),
  patch: z.record(z.unknown()).describe("Fields to update (forbidden: packageName, hashedApiKey, etc.)"),
});

export function registerAppTools(server: McpServer, config: ConsoleMcpConfig): void {
  const cli = () => createCliClient(config);

  server.registerTool(
    "app_list",
    {
      description: "List MiniApps for the authenticated developer (optional orgId filter).",
      inputSchema: { orgId: z.string().optional() },
    },
    async ({ orgId }) => {
      const res = await cli().listApps(orgId);
      return textContent(redactSecrets(unwrapData(res)));
    },
  );

  server.registerTool(
    "app_get",
    {
      description: "Get a MiniApp by package name.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => {
      const res = await cli().getApp(packageName);
      return textContent(redactSecrets(unwrapData(res)));
    },
  );

  server.registerTool(
    "app_create",
    {
      description: `Create a MiniApp. Allowed fields: ${APP_CREATE_FIELDS.join(", ")}. Returns apiKey once.`,
      inputSchema: {
        packageName: z.string().describe("Reverse-domain package name, e.g. com.example.myapp"),
        name: z.string(),
        publicUrl: z.string().url(),
        appType: z.enum(["background", "standard"]).optional(),
        description: z.string().optional(),
        orgId: z.string().optional(),
        tools: z.array(z.record(z.unknown())).optional(),
        permissions: z.array(z.record(z.unknown())).optional(),
        settings: z.array(z.record(z.unknown())).optional(),
        hardwareRequirements: z.record(z.unknown()).optional(),
        onboardingInstructions: z.string().optional(),
      },
    },
    async (input) => {
      const parsed = appCreateSchema.parse(input);
      const { orgId, ...rest } = parsed;
      const body: Record<string, unknown> = { ...rest };
      if (orgId) body.orgId = orgId;
      const res = await cli().createApp(body);
      const data = unwrapData(res) as { app?: unknown; apiKey?: string };
      return textContent({
        ...data,
        app: data.app ? redactSecrets(data.app) : data.app,
        _warning: data.apiKey
          ? "Save apiKey now — it will not be shown again."
          : undefined,
      });
    },
  );

  server.registerTool(
    "app_update",
    {
      description: "Update MiniApp metadata, permissions, settings, or tools.",
      inputSchema: appUpdateSchema.shape,
    },
    async ({ packageName, patch }) => {
      const res = await cli().updateApp(packageName, patch);
      return textContent(redactSecrets(unwrapData(res)));
    },
  );

  server.registerTool(
    "app_delete",
    {
      description: "Delete a MiniApp. Requires confirm: true.",
      inputSchema: {
        packageName: z.string(),
        confirm: z.boolean().describe("Must be true"),
      },
    },
    async ({ packageName, confirm }) => {
      requireConfirm(confirm, "app_delete");
      const res = await cli().deleteApp(packageName);
      return textContent(unwrapData(res));
    },
  );

  server.registerTool(
    "app_publish",
    {
      description: "Publish or submit a MiniApp to the store.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => {
      const res = await cli().publishApp(packageName);
      return textContent(unwrapData(res));
    },
  );

  server.registerTool(
    "app_regenerate_api_key",
    {
      description:
        "Regenerate MiniApp API key. The new key is shown once in the response.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => {
      const res = await cli().regenerateApiKey(packageName);
      const data = unwrapData(res);
      return textContent({
        ...data,
        _warning: "Save the new API key now — it will not be shown again.",
      });
    },
  );

  server.registerTool(
    "app_move_org",
    {
      description: "Move a MiniApp to another organization.",
      inputSchema: {
        packageName: z.string(),
        targetOrgId: z.string(),
      },
    },
    async ({ packageName, targetOrgId }) => {
      const res = await cli().moveApp(packageName, targetOrgId);
      return textContent(unwrapData(res));
    },
  );
}
