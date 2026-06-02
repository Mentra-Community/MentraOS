import type { ConsoleMcpConfig } from "../config.ts";
import { parseJsonResponse } from "./errors.ts";

type QueryParams = Record<string, string | undefined>;

function buildUrl(host: string, path: string, query?: QueryParams): string {
  const url = new URL(path, host);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

export function createCliClient(config: ConsoleMcpConfig) {
  const token = config.cliToken;
  if (!token) {
    throw new Error("CLI client requires MENTRA_CLI_TOKEN");
  }

  async function request<T>(
    method: string,
    path: string,
    options?: { query?: QueryParams; body?: unknown },
  ): Promise<T> {
    const res = await fetch(buildUrl(config.host, path, options?.query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return parseJsonResponse<T>(res);
  }

  return {
    listApps: (orgId?: string) =>
      request<{ success?: boolean; data?: unknown }>("GET", "/api/cli/apps", {
        query: orgId ? { orgId } : undefined,
      }),

    getApp: (packageName: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "GET",
        `/api/cli/apps/${encodeURIComponent(packageName)}`,
      ),

    createApp: (body: Record<string, unknown>) =>
      request<{ success?: boolean; data?: unknown }>("POST", "/api/cli/apps", { body }),

    updateApp: (packageName: string, body: Record<string, unknown>) =>
      request<{ success?: boolean; data?: unknown }>(
        "PUT",
        `/api/cli/apps/${encodeURIComponent(packageName)}`,
        { body },
      ),

    deleteApp: (packageName: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "DELETE",
        `/api/cli/apps/${encodeURIComponent(packageName)}`,
      ),

    publishApp: (packageName: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/apps/${encodeURIComponent(packageName)}/publish`,
      ),

    regenerateApiKey: (packageName: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/apps/${encodeURIComponent(packageName)}/api-key`,
      ),

    moveApp: (packageName: string, targetOrgId: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/apps/${encodeURIComponent(packageName)}/move`,
        { body: { targetOrgId } },
      ),

    listOrgs: () => request<{ success?: boolean; data?: unknown }>("GET", "/api/cli/orgs"),

    getOrg: (orgId: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "GET",
        `/api/cli/orgs/${encodeURIComponent(orgId)}`,
      ),

    createOrg: (name: string) =>
      request<{ success?: boolean; data?: unknown }>("POST", "/api/cli/orgs", {
        body: { name },
      }),

    updateOrg: (orgId: string, body: Record<string, unknown>) =>
      request<{ success?: boolean; data?: unknown }>(
        "PUT",
        `/api/cli/orgs/${encodeURIComponent(orgId)}`,
        { body },
      ),

    deleteOrg: (orgId: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "DELETE",
        `/api/cli/orgs/${encodeURIComponent(orgId)}`,
      ),

    inviteMember: (orgId: string, email: string, role: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/orgs/${encodeURIComponent(orgId)}/members`,
        { body: { email, role } },
      ),

    changeMemberRole: (orgId: string, memberId: string, role: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "PATCH",
        `/api/cli/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
        { body: { role } },
      ),

    removeMember: (orgId: string, memberId: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "DELETE",
        `/api/cli/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      ),

    resendInvite: (orgId: string, email: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/orgs/${encodeURIComponent(orgId)}/invites/resend`,
        { body: { email } },
      ),

    rescindInvite: (orgId: string, email: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/orgs/${encodeURIComponent(orgId)}/invites/rescind`,
        { body: { email } },
      ),

    acceptInvite: (token: string) =>
      request<{ success?: boolean; data?: unknown }>(
        "POST",
        `/api/cli/orgs/accept/${encodeURIComponent(token)}`,
      ),
  };
}

export type CliClient = ReturnType<typeof createCliClient>;
