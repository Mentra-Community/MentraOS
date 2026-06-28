/**
 * @fileoverview Core incident-reporting API.
 *
 * Clean Cloud V2 incident surface: callers create a diagnostic case from a
 * trigger, a report, and a runtime context snapshot, then attach evidence as
 * typed artifacts. This deliberately avoids the Cloud V1 "feedback plus logs"
 * shape.
 */

import type { HttpClient } from "../../http";

const INCIDENTS_PATH = "/api/client/incidents";

export type IncidentStatus = "collecting" | "ready" | "closed";
export type IncidentSystemPriority = "low" | "medium" | "high" | "critical";

export type IncidentTrigger =
  | {
      type: "manual";
      surface: string;
      reason: string;
      sourceAppletPackageName?: string;
      sourceAppletName?: string;
    }
  | {
      type: "automatic";
      area: string;
      reason: string;
      sourceAppletPackageName?: string;
      sourceAppletName?: string;
    };

export interface IncidentReport {
  actualBehavior: string;
  expectedBehavior?: string;
  userSeverity?: 1 | 2 | 3 | 4 | 5;
  systemPriority?: IncidentSystemPriority;
  contactEmail?: string;
}

export interface IncidentContext extends Record<string, unknown> {
  app?: Record<string, unknown>;
  phone?: Record<string, unknown>;
  glasses?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  apps?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface CreateIncidentInput {
  trigger: IncidentTrigger;
  report: IncidentReport;
  context: IncidentContext;
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

export interface CreateIncidentResult {
  incidentId: string;
  status: IncidentStatus;
  created: boolean;
}

export interface IncidentLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

export interface IncidentAttachmentInput {
  uri?: string;
  fileName?: string | null;
  mimeType?: string | null;
  blob?: Blob;
}

export interface AddIncidentArtifactsResult {
  stored: number;
}

export interface IncidentsDeps {
  http: HttpClient;
}

export class Incidents {
  private readonly http: HttpClient;

  constructor(deps: IncidentsDeps) {
    this.http = deps.http;
  }

  create(input: CreateIncidentInput): Promise<CreateIncidentResult> {
    return this.http.post<CreateIncidentResult>(INCIDENTS_PATH, input);
  }

  async addLogs(
    incidentId: string,
    source: string,
    entries: IncidentLogEntry[],
  ): Promise<AddIncidentArtifactsResult> {
    return await this.http.post<AddIncidentArtifactsResult>(
      `${INCIDENTS_PATH}/${encodeURIComponent(incidentId)}/artifacts`,
      {
        type: "logs",
        source,
        entries,
      },
    );
  }

  addScreenshots(
    incidentId: string,
    images: IncidentAttachmentInput[],
  ): Promise<AddIncidentArtifactsResult> {
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
        throw new Error("incident screenshot requires either blob or uri");
      }
      // React Native FormData accepts a {uri,name,type} file object. The DOM
      // typing only knows Blob/File, so narrow this platform object at the
      // boundary where it is appended.
      form.append("files", {
        uri: image.uri,
        name: filename,
        type: mimeType,
      } as unknown as Blob);
    }

    return this.http.postForm<AddIncidentArtifactsResult>(
      `${INCIDENTS_PATH}/${encodeURIComponent(incidentId)}/artifacts`,
      form,
    );
  }

  complete(incidentId: string): Promise<{ status: IncidentStatus }> {
    return this.http.post<{ status: IncidentStatus }>(
      `${INCIDENTS_PATH}/${encodeURIComponent(incidentId)}/complete`,
      {},
    );
  }
}
