/** Stateless device-facing REST calls owned by Cloud Core. */
import type {HttpClient} from "../../http"
import {
  Reports,
  type AddReportArtifactsResult,
  type ReportAttachmentInput,
  type ReportLogEntry,
  type ReportStatus,
  type SubmitReportInput,
  type SubmitReportResult,
} from "./reports"
import {SupportProfiles, type SupportProfileUpdateResult, type SupportStateInput} from "./support-profile"

export type {
  AddReportArtifactsResult,
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportKind,
  ReportLogEntry,
  ReportStatus,
  ReportSystemPriority,
  ReportTrigger,
  SubmitReportInput,
  SubmitReportResult,
} from "./reports"
export type {SupportConnectionState, SupportProfileUpdateResult, SupportStateInput} from "./support-profile"

export class Core {
  readonly reports: {
    submit(input: SubmitReportInput): Promise<SubmitReportResult>
    addLogs(reportId: string, source: string, entries: ReportLogEntry[]): Promise<AddReportArtifactsResult>
    addScreenshots(reportId: string, images: ReportAttachmentInput[]): Promise<AddReportArtifactsResult>
    complete(reportId: string): Promise<{status: ReportStatus}>
  }
  readonly supportProfile: {
    update(input: SupportStateInput): Promise<SupportProfileUpdateResult>
  }

  constructor(deps: {http: HttpClient}) {
    const reports = new Reports({http: deps.http})
    const supportProfiles = new SupportProfiles(deps.http)
    this.reports = {
      submit: reports.submit.bind(reports),
      addLogs: reports.addLogs.bind(reports),
      addScreenshots: reports.addScreenshots.bind(reports),
      complete: reports.complete.bind(reports),
    }
    this.supportProfile = {update: supportProfiles.update.bind(supportProfiles)}
  }
}
