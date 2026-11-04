import {createLogger} from "@mentra/cloud-shared"
import {ReportServerLogCollectionService} from "./report-server-log-collection.service"
import {ReportSlackDeliveryService} from "./report-slack-delivery.service"

const logger = createLogger("core").child({service: "report-reconciliation"})

export const REPORT_RECONCILIATION_INTERVAL_MS = 15_000

/** Finishes reports' durable work: server log collection and Slack retries. Returns how to stop. */
export function startReportReconciliation(
  services: Array<{tick(): Promise<void>}> = [new ReportSlackDeliveryService(), new ReportServerLogCollectionService()],
  intervalMs = REPORT_RECONCILIATION_INTERVAL_MS,
): () => Promise<void> {
  let stopped = false
  let active: Promise<void> | undefined
  const tick = () => {
    if (stopped || active) return
    active = Promise.allSettled(services.map(async service => service.tick()))
      .then(results => {
        for (const result of results)
          if (result.status === "rejected") logger.error({err: result.reason}, "report reconciliation failed")
      })
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await active
  }
}
