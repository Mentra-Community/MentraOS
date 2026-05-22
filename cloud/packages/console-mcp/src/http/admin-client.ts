import type { ConsoleMcpConfig } from "../config.ts";
import { parseJsonResponse } from "./errors.ts";

export function createAdminClient(config: ConsoleMcpConfig) {
  const token = config.adminJwt;
  if (!token) {
    throw new Error("Admin client requires MENTRA_ADMIN_JWT or MENTRA_ADMIN_TOKEN");
  }

  async function request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(new URL(path, config.host).toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return parseJsonResponse<T>(res);
  }

  return {
    check: () => request<{ isAdmin: boolean; email: string }>("GET", "/api/admin/check"),

    appStats: () => request<unknown>("GET", "/api/admin/apps/stats"),

    appsSubmitted: () => request<unknown>("GET", "/api/admin/apps/submitted"),

    getApp: (packageName: string) =>
      request<unknown>("GET", `/api/admin/apps/${encodeURIComponent(packageName)}`),

    approveApp: (packageName: string, notes?: string) =>
      request<unknown>("POST", `/api/admin/apps/${encodeURIComponent(packageName)}/approve`, {
        notes,
      }),

    rejectApp: (packageName: string, notes: string) =>
      request<unknown>("POST", `/api/admin/apps/${encodeURIComponent(packageName)}/reject`, {
        notes,
      }),
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;
