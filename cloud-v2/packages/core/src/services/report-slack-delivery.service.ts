import {createHash, randomUUID} from "node:crypto"
import {ReportModel} from "../models/report.model"
import {
  notifyReportSlack,
  reconcileReportSlack,
  type ReportSlackNotification,
  type ReportSlackResult,
} from "./report-slack.service"
import {TestRunError} from "./test-result-error"

export interface ReportSlackDelivery {
  state: "pending" | "sending" | "uncertain" | "sent"
  attemptId?: string
  startedAt?: string
  leaseUntil?: string
  nextAttemptAt?: string
  channel?: string
  ts?: string
  error?: string
  destination?: string
}
interface DeliveryRepository {
  read(reportId: string): Promise<ReportSlackDelivery | undefined>
  claim(reportId: string, previous: ReportSlackDelivery | undefined, value: ReportSlackDelivery): Promise<boolean>
  settle(reportId: string, attemptId: string, value: ReportSlackDelivery): Promise<boolean>
  due?(): Promise<ReportSlackNotification[]>
}
const writeConcern = {w: "majority" as const, j: true, wtimeout: 10_000}
const repository: DeliveryRepository = {
  async read(reportId) {
    const row = await ReportModel.findOne({reportId})
      .select({slackDelivery: 1})
      .read("primary")
      .readConcern("majority")
      .setOptions({timeoutMS: 10_000})
      .lean()
    if (!row) throw new TestRunError(503, "Routine incident is unavailable")
    return row.slackDelivery as ReportSlackDelivery | undefined
  },
  async claim(reportId, previous, value) {
    const result = await ReportModel.updateOne(
      {reportId, ...(previous ? {slackDelivery: previous} : {slackDelivery: {$exists: false}})},
      {$set: {slackDelivery: value, ...(!previous ? {status: "ready"} : {})}},
      {writeConcern, timeoutMS: 10_000},
    )
    return result.matchedCount === 1
  },
  async settle(reportId, attemptId, value) {
    const result = await ReportModel.updateOne(
      {reportId, "slackDelivery.attemptId": attemptId},
      {$set: {slackDelivery: value}},
      {writeConcern, timeoutMS: 10_000},
    )
    return result.matchedCount === 1
  },
  async due() {
    const rows = await ReportModel.find({"slackDelivery.nextAttemptAt": {$lte: new Date().toISOString()}})
      .sort({"slackDelivery.nextAttemptAt": 1})
      .limit(10)
      .read("primary")
      .readConcern("majority")
      .setOptions({timeoutMS: 10_000})
      .lean()
    return rows.map(
      (row) =>
        ({
          reportId: row.reportId,
          mentraUserId: row.mentraUserId,
          kind: row.kind,
          trigger: row.trigger,
          report: row.report,
          context: row.context,
          artifactCount: row.artifacts.length,
        } as ReportSlackNotification),
    )
  },
}
function messageId(reportId: string) {
  const hex = createHash("sha256").update(`routine-incident\n${reportId}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Cloud reporting owns retries once native evidence has been acknowledged. */
export class ReportSlackDeliveryService {
  constructor(
    private readonly store: DeliveryRepository = repository,
    private readonly send: typeof notifyReportSlack = notifyReportSlack,
    private readonly reconcile: typeof reconcileReportSlack = reconcileReportSlack,
    private readonly now: () => number = Date.now,
    private readonly destination: () => string | undefined = () =>
      process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_TESTING?.trim(),
  ) {}

  async complete(notification: ReportSlackNotification): Promise<ReportSlackDelivery> {
    const previous = await this.store.read(notification.reportId)
    if (previous?.state === "uncertain" || previous?.state === "sending") {
      if (previous.destination !== this.destination()) return previous
    }
    if (previous?.state === "sent") return previous
    if (previous?.state === "sending" && Date.parse(previous.leaseUntil ?? "") > this.now()) return previous
    if (previous?.nextAttemptAt && Date.parse(previous.nextAttemptAt) > this.now()) return previous
    const attemptId = randomUUID(),
      startedAt =
        previous?.state === "uncertain" || previous?.state === "sending"
          ? previous.startedAt ?? new Date(this.now()).toISOString()
          : new Date(this.now()).toISOString()
    const leaseUntil = new Date(this.now() + 30_000).toISOString()
    // This durable intent precedes the network write. A crash leaves a due intent,
    // and any expired sending intent is reconciled rather than posted twice.
    const destination =
      previous?.state === "uncertain" || previous?.state === "sending" ? previous.destination : this.destination()
    const value: ReportSlackDelivery = {
      state: "sending",
      attemptId,
      startedAt,
      leaseUntil,
      nextAttemptAt: leaseUntil,
      ...(destination ? {destination} : {}),
    }
    if (!(await this.store.claim(notification.reportId, previous, value))) {
      const current = await this.store.read(notification.reportId)
      if (!current) throw new TestRunError(503, "Routine incident notification intent is unavailable")
      return current
    }
    const clientMessageId = messageId(notification.reportId)
    let result: ReportSlackResult
    try {
      result =
        previous?.state === "uncertain" || previous?.state === "sending"
          ? await this.reconcile(notification.reportId, clientMessageId, startedAt)
          : await this.send(notification, {clientMessageId})
      if (!result.ok && result.retryable && (previous?.state === "uncertain" || previous?.state === "sending"))
        result = await this.send(notification, {clientMessageId})
    } catch {
      result = {ok: false}
    }
    const delivered = result.ok && result.receipt
    const settled: ReportSlackDelivery = delivered
      ? {state: "sent", startedAt, ...delivered, ...(destination ? {destination} : {})}
      : {
          state: result.retryable ? "pending" : "uncertain",
          startedAt,
          ...(destination ? {destination} : {}),
          nextAttemptAt: new Date(this.now() + 60_000).toISOString(),
          error: result.retryable
            ? "Slack refused the notification; cloud reporting will retry."
            : "Slack delivery is unconfirmed; cloud reporting will reconcile before another post.",
        }
    // Even an ambiguous settle failure retains the original durable intent. Native
    // custody can be acknowledged; the reporting timer recovers the expired lease.
    try {
      if (!(await this.store.settle(notification.reportId, attemptId, settled))) return value
    } catch {
      return value
    }
    return settled
  }
  async tick() {
    await Promise.all(
      ((await this.store.due?.()) ?? []).map((notification) => this.complete(notification).catch(() => undefined)),
    )
  }
}
