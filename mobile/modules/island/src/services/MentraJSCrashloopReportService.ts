import {submitAutomaticReport, type ReportSubmitResult} from "../facades/reports"
import {useAppStatusStore} from "../stores/apps"
import {getMiniappEngine} from "./MiniappEngine"
import {islandNotifications, type IslandNotification} from "./NotificationsEmitter"

const LOG_TAG = "MentraJSCrashloopReport"

let unsubscribe: (() => void) | null = null

function buildSubmitStatus(result: ReportSubmitResult):
  | {status: "filed"; reportId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string} {
  if (result.status === "submitted") {
    return {status: "filed", reportId: result.reportId}
  }
  if (result.status === "skipped") {
    return {status: "skipped", reason: result.reason}
  }
  return {status: "failed", error: result.error}
}

export async function submitMentraJSCrashloopReport(params: {
  packageName: string
  reason: string
  lastLogLines?: string[]
}): Promise<ReturnType<typeof buildSubmitStatus>> {
  const {packageName, reason, lastLogLines = []} = params
  const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
  const appName = app?.name ?? packageName
  const result = await submitAutomaticReport({
    kind: "automatic",
    trigger: {
      type: "automatic",
      source: "miniapp_crashloop",
      reason: "mentrajs_crashloop_disabled",
      sourceAppletPackageName: packageName,
      sourceAppletName: appName,
    },
    report: {
      expectedBehavior: `${appName} should run without crashing.`,
      actualBehavior: JSON.stringify({reason, lastLogLines}, null, 2),
      systemPriority: "critical",
    },
    dedupeKey: `mentrajs_crashloop:${packageName}`,
  })

  const status = buildSubmitStatus(result)
  if (status.status === "filed") {
    console.log(`[${LOG_TAG}] Report filed:`, status.reportId)
  } else if (status.status === "skipped") {
    console.log(`[${LOG_TAG}] Skipping duplicate within window:`, packageName)
  } else {
    console.error(`[${LOG_TAG}] submit failed:`, status.error)
  }
  return status
}

function handleNotification(notification: IslandNotification): void {
  if (notification.kind !== "miniapp_crashloop" || !notification.packageName) return
  const packageName = notification.packageName
  const lastLogLines = getMiniappEngine()?.router.logRing.snapshot(packageName) ?? []
  void submitMentraJSCrashloopReport({
    packageName,
    reason: notification.reason,
    lastLogLines,
  }).catch((error) => {
    console.error(`[${LOG_TAG}] Unexpected error:`, error)
  })
}

export function startMentraJSCrashloopReportService(): void {
  if (unsubscribe) return
  unsubscribe = islandNotifications.subscribe(handleNotification)
}

export function stopMentraJSCrashloopReportService(): void {
  unsubscribe?.()
  unsubscribe = null
}
