/**
 * @fileoverview `cloud.core`: the device's stateless v2 REST calls.
 *
 * This is the simplest module: no live connection and no session state, so any
 * cloud pod can serve any call here. Each request goes through the shared HTTP
 * helper, which attaches the access token from `cloud.auth` as the Bearer, so
 * core never touches credentials itself.
 *
 * Today it exposes the unified report submission surface and the support
 * profile update.
 *
 * Guardrail: this is device-facing only. It deliberately carries none of the
 * Dev Console / OEM Portal / store web UI surface; those are separate clients.
 *
 * See docs/issues/004-cloud-client/spec.md ("cloud.core") and design.md
 * ("src/modules/core/core.ts").
 */
import type { HttpClient } from "../../http";
import {
  Reports,
  type AddReportArtifactsResult,
  type AddReportLogsOptions,
  type ReportAttachmentInput,
  type ReportLogEntry,
  type ReportLogCollectionUpdate,
  type ReportLogCollectionSnapshot,
  type ReportLogSource,
  type ReportStatus,
  type SubmitReportInput,
  type SubmitReportResult,
} from "./reports";
import {
  SupportProfiles,
  type SupportProfileUpdateResult,
  type SupportStateInput,
} from "./support-profile";

export type {
  AddReportArtifactsResult,
  AddReportLogsOptions,
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportKind,
  ReportLogEntry,
  ReportLogCollectionUpdate,
  ReportLogCollection,
  ReportLogCollectionSnapshot,
  ReportLogSource,
  ReportStatus,
  ReportSystemPriority,
  ReportTrigger,
  SubmitReportInput,
  SubmitReportResult,
} from "./reports";
export type {
  SupportConnectionState,
  SupportProfileUpdateResult,
  SupportStateInput,
} from "./support-profile";

/** The dependencies `cloud.core` is wired with. */
export interface CoreDeps {
  http: HttpClient;
}

/**
 * `cloud.core`. Stateless REST grouped by resource.
 *
 * Each group is exposed as a plain object so callers write
 * `cloud.core.reports.submit()`. Methods are bound in the constructor so
 * destructuring a group keeps working.
 */
export class Core {
  readonly reports: {
    getLogCollection(reportId: string, signal?: AbortSignal): Promise<ReportLogCollectionSnapshot>;
    submit(input: SubmitReportInput): Promise<SubmitReportResult>;
    updateLogCollection(
      reportId: string,
      source: ReportLogSource,
      update: ReportLogCollectionUpdate,
    ): Promise<void>;
    addLogs(
      reportId: string,
      source: string,
      entries: ReportLogEntry[],
      options?: AddReportLogsOptions,
    ): Promise<AddReportArtifactsResult>;
    addScreenshots(
      reportId: string,
      images: ReportAttachmentInput[],
    ): Promise<AddReportArtifactsResult>;
    addVideos(
      reportId: string,
      source: string,
      videos: ReportAttachmentInput[],
    ): Promise<AddReportArtifactsResult>;
    complete(reportId: string): Promise<{ status: ReportStatus }>;
  };
  readonly supportProfile: {
    update(input: SupportStateInput): Promise<SupportProfileUpdateResult>;
  };

  constructor(deps: CoreDeps) {
    const { http } = deps;
    const reports = new Reports({ http });
    const supportProfiles = new SupportProfiles(http);

    this.reports = {
      submit: reports.submit.bind(reports),
      getLogCollection: reports.getLogCollection.bind(reports),
      updateLogCollection: reports.updateLogCollection.bind(reports),
      addLogs: reports.addLogs.bind(reports),
      addScreenshots: reports.addScreenshots.bind(reports),
      addVideos: reports.addVideos.bind(reports),
      complete: reports.complete.bind(reports),
    };
    this.supportProfile = {
      update: supportProfiles.update.bind(supportProfiles),
    };
  }
}
