import axios from "axios"

import type {ClientAppletInterface} from "@/stores/applets"
import {submitAutomaticBugIncident} from "./automaticBugReport"

interface SerializedStartAppError {
  message: string
  status?: number
  code?: string
  responseData?: unknown
  noActiveSession: boolean
}

function serializeStartAppError(error: unknown): SerializedStartAppError {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data as {error?: string} | undefined
    return {
      message: error.message,
      status: error.response?.status,
      code: error.code,
      responseData,
      noActiveSession: error.response?.status === 503 && responseData?.error === "NO_ACTIVE_SESSION",
    }
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      noActiveSession: false,
    }
  }

  return {
    message: String(error),
    noActiveSession: false,
  }
}

export async function submitMiniappStartFailedBugReport(
  applet: ClientAppletInterface,
  error: unknown,
  phase: "initial_start" | "retry_start" = "initial_start",
): Promise<void> {
  const serialized = serializeStartAppError(error)
  const dedupeKey = [
    "miniapp_start_failed",
    applet.packageName,
    serialized.status ?? "unknown",
    serialized.code ?? "unknown",
    serialized.noActiveSession ? "no_active_session" : "other",
  ].join("|")

  const actualBehavior = JSON.stringify(
    {
      phase,
      packageName: applet.packageName,
      appName: applet.name,
      startError: serialized,
    },
    null,
    2,
  )

  await submitAutomaticBugIncident({
    categorization: {
      submissionMode: "AUTOMATIC",
      triggerArea: "miniapp_launch",
      triggerReason: "miniapp_start_failed",
      sourceAppletPackageName: applet.packageName,
      sourceAppletName: applet.name,
    },
    expectedBehavior: `${applet.name} should start and become reachable.`,
    actualBehavior,
    severityRating: 4,
    dedupeKey,
    logTag: "MiniappStartBugReport",
  })
}
