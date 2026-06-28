/**
 * @fileoverview Core incident-reporting API.
 *
 * Thin client over Cloud V2 core's device-called incident endpoints. The
 * toolkit owns the filing flow; this module owns auth, paths, JSON/multipart
 * request mechanics, and response typing.
 */

import type { HttpClient } from "../../http";

const INCIDENTS_PATH = "/api/incidents";
const FEEDBACK_PATH = "/api/client/feedback";

export interface IncidentLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

export type IncidentSubmissionMode = "USER_INITIATED" | "AUTOMATIC";

export interface IncidentBugFeedback extends Record<string, unknown> {
  type: "bug";
  expectedBehavior: string;
  actualBehavior: string;
  severityRating: number;
  submissionMode: IncidentSubmissionMode;
  triggerArea: string;
  triggerReason: string;
  systemInfo: Record<string, unknown>;
  contactEmail?: string;
  glassesInfo?: Record<string, unknown>;
  sourceAppletPackageName?: string;
  sourceAppletName?: string;
}

export interface IncidentAttachmentInput {
  uri?: string;
  fileName?: string | null;
  mimeType?: string | null;
  blob?: Blob;
}

export interface CreateIncidentResult {
  success: boolean;
  incidentId: string;
}

export interface UploadIncidentAttachmentsResult {
  uploaded: number;
  errors: number;
}

export interface IncidentsDeps {
  http: HttpClient;
}

export class Incidents {
  private readonly http: HttpClient;

  constructor(deps: IncidentsDeps) {
    this.http = deps.http;
  }

  create(
    feedback: IncidentBugFeedback,
    phoneState: Record<string, unknown>,
  ): Promise<CreateIncidentResult> {
    return this.http.post<CreateIncidentResult>(INCIDENTS_PATH, {
      feedback,
      phoneState,
    });
  }

  async uploadLogs(incidentId: string, logs: IncidentLogEntry[]): Promise<void> {
    await this.http.post<{ success: boolean }>(
      `${INCIDENTS_PATH}/${encodeURIComponent(incidentId)}/logs`,
      {
        source: "phone",
        logs,
      },
    );
  }

  uploadAttachments(
    incidentId: string,
    images: IncidentAttachmentInput[],
  ): Promise<UploadIncidentAttachmentsResult> {
    const form = new FormData();
    for (const image of images) {
      const filename = image.fileName || `screenshot-${Date.now()}.jpg`;
      const mimeType = image.mimeType || "image/jpeg";
      if (image.blob) {
        form.append("files", image.blob, filename);
        continue;
      }
      if (!image.uri) {
        throw new Error("incident attachment requires either blob or uri");
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

    return this.http.postForm<UploadIncidentAttachmentsResult>(
      `${INCIDENTS_PATH}/${encodeURIComponent(incidentId)}/attachments`,
      form,
    );
  }

  sendFeedback(
    feedback: string | Record<string, unknown>,
    phoneState?: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(FEEDBACK_PATH, {
      feedback,
      ...(phoneState && { phoneState }),
    });
  }
}
