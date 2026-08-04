import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config.ts";
import { createCliClient } from "../http/cli-client.ts";
import { requireConfirm, textContent, unwrapData } from "./helpers.ts";

export function registerOrgTools(server: McpServer, config: ConsoleMcpConfig): void {
  const cli = () => createCliClient(config);

  server.registerTool(
    "org_list",
    { description: "List organizations for the authenticated developer.", inputSchema: {} },
    async () => textContent(unwrapData(await cli().listOrgs())),
  );

  server.registerTool(
    "org_get",
    {
      description: "Get organization by ID.",
      inputSchema: { orgId: z.string() },
    },
    async ({ orgId }) => textContent(unwrapData(await cli().getOrg(orgId))),
  );

  server.registerTool(
    "org_create",
    {
      description: "Create a new organization.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => textContent(unwrapData(await cli().createOrg(name))),
  );

  server.registerTool(
    "org_update",
    {
      description: "Update organization profile/settings.",
      inputSchema: {
        orgId: z.string(),
        patch: z.record(z.unknown()),
      },
    },
    async ({ orgId, patch }) => textContent(unwrapData(await cli().updateOrg(orgId, patch))),
  );

  server.registerTool(
    "org_delete",
    {
      description: "Delete an organization. Requires confirm: true.",
      inputSchema: { orgId: z.string(), confirm: z.boolean() },
    },
    async ({ orgId, confirm }) => {
      requireConfirm(confirm, "org_delete");
      return textContent(unwrapData(await cli().deleteOrg(orgId)));
    },
  );

  server.registerTool(
    "org_invite_member",
    {
      description: "Invite a member to an organization.",
      inputSchema: {
        orgId: z.string(),
        email: z.string().email(),
        role: z.enum(["admin", "member"]).optional(),
      },
    },
    async ({ orgId, email, role }) =>
      textContent(unwrapData(await cli().inviteMember(orgId, email, role || "member"))),
  );

  server.registerTool(
    "org_change_member_role",
    {
      description: "Change a member role in an organization.",
      inputSchema: {
        orgId: z.string(),
        memberId: z.string(),
        role: z.enum(["admin", "member"]),
      },
    },
    async ({ orgId, memberId, role }) =>
      textContent(unwrapData(await cli().changeMemberRole(orgId, memberId, role))),
  );

  server.registerTool(
    "org_remove_member",
    {
      description: "Remove a member from an organization.",
      inputSchema: { orgId: z.string(), memberId: z.string() },
    },
    async ({ orgId, memberId }) =>
      textContent(unwrapData(await cli().removeMember(orgId, memberId))),
  );

  server.registerTool(
    "org_resend_invite",
    {
      description: "Resend a pending organization invite email.",
      inputSchema: { orgId: z.string(), email: z.string().email() },
    },
    async ({ orgId, email }) => textContent(unwrapData(await cli().resendInvite(orgId, email))),
  );

  server.registerTool(
    "org_rescind_invite",
    {
      description: "Rescind a pending organization invite.",
      inputSchema: { orgId: z.string(), email: z.string().email() },
    },
    async ({ orgId, email }) => textContent(unwrapData(await cli().rescindInvite(orgId, email))),
  );

  server.registerTool(
    "org_accept_invite",
    {
      description: "Accept an organization invite using the invite token.",
      inputSchema: { token: z.string() },
    },
    async ({ token }) => textContent(unwrapData(await cli().acceptInvite(token))),
  );
}
