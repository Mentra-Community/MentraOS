/**
 * @fileoverview Cloud V2 user/system reporting API.
 *
 * A report is the single device-facing primitive for manual bug reports,
 * feature/general feedback, and automatic runtime reports. The engine supplies
 * diagnostic context and artifacts; host UI supplies only user-visible content.
 */

import type { HttpClient } from "../../http";

const REPORTS_PATH = "/api/client/reports";

export type ReportKind = "bug" | "feedback" | "automatic";
export type ReportStatus = "collecting" | "ready" | "closed";
export type ReportSystemPriority = "low" | "medium" | "high" | "critical";

interface BaseReportTrigger {
  source: string;
  reason: string;
  sourceAppletPackageName?: string;
  sourceAppletName?: string;
}

export type ReportTrigger =
  | (BaseReportTrigger & { type: "manual" })
  | (BaseReportTrigger & { type: "automatic" });

export interface ReportDetails {
  actualBehavior: string;
  expectedBehavior?: string;
  userSeverity?: 1 | 2 | 3 | 4 | 5;
  systemPriority?: ReportSystemPriority;
  contactEmail?: string;
}

export interface ReportContext extends Record<string, unknown> {
  app?: Record<string, unknown>;
  phone?: Record<string, unknown>;
  glasses?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  apps?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export type SubmitReportInput =
  | {
      kind: "bug";
      trigger: ReportTrigger;
      report: ReportDetails;
      context: ReportContext;
    }
  | {
      kind: "automatic";
      trigger: Extract<ReportTrigger, { type: "automatic" }>;
      report: ReportDetails;
      context: ReportContext;
    }
  | {
      kind: "feedback";
      feedback: string | Record<string, unknown>;
      context: ReportContext;
    };

export interface SubmitReportResult {
  reportId: string;
  status: ReportStatus;
}

export interface ReportLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface ReportAttachmentInput {
  uri?: string;
  fileName?: string | null;
  mimeType?: string | null;
  blob?: Blob;
}

export interface AddReportArtifactsResult {
  stored: number;
}

export interface ReportsDeps {
  http: HttpClient;
}

export class Reports {
  private readonly http: HttpClient;

  constructor(deps: ReportsDeps) {
    this.http = deps.http;
  }

  submit(input: SubmitReportInput): Promise<SubmitReportResult> {
    return this.http.post<SubmitReportResult>(REPORTS_PATH, input);
  }

  async addLogs(
    reportId: string,
    source: string,
    entries: ReportLogEntry[],
  ): Promise<AddReportArtifactsResult> {
    return await this.http.post<AddReportArtifactsResult>(
      `${REPORTS_PATH}/${encodeURIComponent(reportId)}/artifacts`,
      {
        type: "logs",
        source,
        entries,
      },
    );
  }

  addScreenshots(
    reportId: string,
    images: ReportAttachmentInput[],
  ): Promise<AddReportArtifactsResult> {
    const form = new FormData();
    form.append("type", "screenshot");
    form.append("source", "phone");
    for (const image of images) {
      const filename = image.fileName || `screenshot-${Date.now()}.jpg`;
      const mimeType = image.mimeType || "image/jpeg";
      if (image.blob) {
        form.append("files", image.blob, filename);
        continue;
      }
      if (!image.uri) {
        throw new Error("report screenshot requires either blob or uri");
      }
      form.append("files", {
        uri: image.uri,
        name: filename,
        type: mimeType,
      } as unknown as Blob);
    }

    return this.http.postForm<AddReportArtifactsResult>(
      `${REPORTS_PATH}/${encodeURIComponent(reportId)}/artifacts`,
      form,
    );
  }

  complete(reportId: string): Promise<{ status: ReportStatus }> {
    return this.http.post<{ status: ReportStatus }>(
      `${REPORTS_PATH}/${encodeURIComponent(reportId)}/complete`,
      {},
    );
  }
}
