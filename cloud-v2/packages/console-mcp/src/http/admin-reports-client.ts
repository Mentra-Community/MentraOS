/**
 * HTTP client for the Cloud V2 admin reports API (introduced with the admin
 * report triage viewer):
 *
 *   GET /api/admin/reports                                — newest-first list
 *   GET /api/admin/reports/:reportId                      — report + asset rows
 *   GET /api/admin/reports/:reportId/artifacts/:artifactId — raw payload bytes
 *   GET /api/admin/me                                     — auth/allowlist check
 *
 * All routes sit behind the core adminAuth gate; requests authenticate with
 * "Authorization: Bearer <MENTRA_ADMIN_TOKEN>" (org msk_ API key allowlisted
 * via CLOUD_CORE_ADMIN_EMAILS, or a WorkOS admin access token).
 */

import type { ConsoleMcpConfig } from "../config";
import { ApiRequestError, describeAdminApiStatus, parseJsonResponse } from "./errors";

export type ReportKind = "bug" | "feedback" | "automatic";
export type ReportStatus = "collecting" | "ready" | "closed";
export type ReportArtifactType = "logs" | "screenshot" | "state_snapshot";

export interface ReportArtifactMeta {
  artifactId: string;
  type: ReportArtifactType;
  source: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

export interface ReportSummary {
  reportId: string;
  kind: ReportKind;
  status: ReportStatus;
  mentraUserId: string;
  trigger: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  feedback: unknown;
  artifacts: ReportArtifactMeta[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReportDetail extends ReportSummary {
  context: Record<string, unknown>;
}

export interface ReportAsset {
  artifactId: string;
  storageKey: string;
  fileName: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string | null;
}

/** One entry of a "logs" artifact bundle ({entries: [...]}). */
export interface ReportLogEntry {
  timestamp: number | string;
  level: string;
  message: string;
  source?: string;
}

export interface ListReportsFilter {
  kind?: ReportKind;
  status?: ReportStatus;
  limit?: number;
  before?: string;
}

export interface ArtifactPayload {
  bytes: Uint8Array;
  contentType: string;
  fileName: string | null;
}

export function createAdminReportsClient(config: ConsoleMcpConfig) {
  const token = config.adminToken;
  if (!token) {
    throw new Error("Admin reports client requires MENTRA_ADMIN_TOKEN");
  }

  function url(path: string, query?: Record<string, string>): string {
    const u = new URL(`${config.coreUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async function getJson<T>(path: string, what: string, query?: Record<string, string>): Promise<T> {
    const res = await fetch(url(path, query), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    return parseJsonResponse<T>(res, what);
  }

  return {
    me: () =>
      getJson<{ authenticated: boolean; admin: boolean; user: Record<string, unknown> | null }>(
        "/api/admin/me",
        "admin identity",
      ),

    listReports: (filter: ListReportsFilter = {}) => {
      const query: Record<string, string> = {};
      if (filter.kind) query.kind = filter.kind;
      if (filter.status) query.status = filter.status;
      if (filter.limit !== undefined) query.limit = String(filter.limit);
      if (filter.before) query.before = filter.before;
      return getJson<{ reports: ReportSummary[] }>("/api/admin/reports", "report list", query);
    },

    getReport: (reportId: string) =>
      getJson<{ report: ReportDetail; assets: ReportAsset[] }>(
        `/api/admin/reports/${encodeURIComponent(reportId)}`,
        `report ${reportId}`,
      ),

    getArtifact: async (reportId: string, artifactId: string): Promise<ArtifactPayload> => {
      const what = `artifact ${artifactId} of report ${reportId}`;
      const res = await fetch(
        url(
          `/api/admin/reports/${encodeURIComponent(reportId)}/artifacts/${encodeURIComponent(artifactId)}`,
        ),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new ApiRequestError(
          `${describeAdminApiStatus(res.status, what)}${body ? `: ${body.slice(0, 500)}` : ""}`,
          res.status,
          body,
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const contentType = (res.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]
        .trim();
      const disposition = res.headers.get("content-disposition") ?? "";
      const fileName = /filename="([^"]*)"/.exec(disposition)?.[1] || null;
      return { bytes, contentType, fileName };
    },
  };
}

export type AdminReportsClient = ReturnType<typeof createAdminReportsClient>;
